/**
 * The Notifications Center feed — DERIVED on every read from the records that
 * raise each condition, never stored. A row id is `<kind>:<recordId>`, stable
 * for as long as the condition holds, so per-account read state keyed by it
 * survives a rebuild.
 *
 * Shifts dated yesterday..tomorrow (tenant tz), evaluated against SERVER now:
 *   shiftUnderstaffed      endsAt > now AND assigned < needed
 *                          count = needed − assigned, occurredAt = startsAt
 *                          needs shift.assign OR shift.manage
 *   shiftAttendanceMissing endsAt ≤ now < endsAt + attendanceGraceMinutes AND
 *                          attendees still `notCheckedIn` > 0
 *                          count = that number, occurredAt = endsAt
 *                          needs shift.attendance.record (or .override)
 *   shiftStartingSoon      0 ≤ startsAt − now ≤ 6 h, count 0, occurredAt = startsAt
 *                          needs detachment.view; dropped when prefs.shiftReminders = false
 * Stock (inventory module on; prefs.stockAlerts ≠ false), ONE row per item,
 * worst wins:
 *   stockDepleted  level empty                   count 0,            occurredAt = now
 *   stockLow       level low                     count = currentStock, occurredAt = now
 *   stockExpiring  expiresOn ≤ today + 30 (expired included)
 *                  count = days left (negative once expired), occurredAt = expiresOn 00:00 tenant tz
 * Announcements (announcements module on): every announcement addressed to the
 * detachment, any status, already published → kind `announcement`, isRead
 * always true (no read state, never counted as unread), dropped when its id is
 * in the caller's cleared set.
 */
const { Shift, InventoryItem, Announcement, NotificationState } = require('../models');
const { canIn, canAnyIn } = require('../config/capabilities');
const { EXPIRING_SOON_DAYS } = require('../config/constants');
const settingsService = require('./settingsService');
const { todayIn, addDays, diffDays, dayMinutesToInstant, iso } = require('../utils/time');

const STARTING_SOON_MS = 6 * 60 * 60 * 1000;
const STATE_CAP = 5000;

const nid = (kind, recordId) => `${kind}:${recordId}`;

/** The caller's stored read/cleared sets (empty when never written). */
const stateOf = async (accountId) => {
  const st = await NotificationState.findOne({ accountId: String(accountId) }).lean();
  return { readIds: st ? st.readIds || [] : [], clearedIds: st ? st.clearedIds || [] : [] };
};

const shiftRows = (shifts, { detachmentId, grant, now, graceMs, prefs }) => {
  const rows = [];
  const canStaff = canAnyIn(grant, detachmentId, ['shift.assign', 'shift.manage']);
  const canAttend = canAnyIn(grant, detachmentId, ['shift.attendance.record', 'shift.attendance.override']);
  const canView = canIn(grant, detachmentId, 'detachment.view');
  const t = now.getTime();

  shifts.forEach((s) => {
    const id = String(s._id);
    const start = new Date(s.startsAt).getTime();
    const end = new Date(s.endsAt).getTime();
    const attendees = s.attendees || [];
    const target = { type: 'shift', detachmentId, shiftId: id };

    if (canStaff && end > t && attendees.length < s.needed) {
      rows.push({
        id: nid('shiftUnderstaffed', id),
        kind: 'shiftUnderstaffed',
        occurredAt: iso(s.startsAt),
        count: s.needed - attendees.length,
        recordLabel: s.centerName,
        target,
      });
    }

    if (canAttend && end <= t && t < end + graceMs) {
      const awaiting = attendees.filter((a) => (a.attendance || 'notCheckedIn') === 'notCheckedIn').length;
      if (awaiting > 0) {
        rows.push({
          id: nid('shiftAttendanceMissing', id),
          kind: 'shiftAttendanceMissing',
          occurredAt: iso(s.endsAt),
          count: awaiting,
          recordLabel: s.centerName,
          target,
        });
      }
    }

    const untilStart = start - t;
    if (canView && prefs.shiftReminders !== false && untilStart >= 0 && untilStart <= STARTING_SOON_MS) {
      rows.push({
        id: nid('shiftStartingSoon', id),
        kind: 'shiftStartingSoon',
        occurredAt: iso(s.startsAt),
        count: 0,
        recordLabel: s.centerName,
        target,
      });
    }
  });
  return rows;
};

const stockRows = (items, { detachmentId, now, today, tz }) => {
  const rows = [];
  const horizon = addDays(today, EXPIRING_SOON_DAYS);
  items.forEach((item) => {
    const id = String(item._id);
    const base = { recordLabel: item.name, target: { type: 'storage', detachmentId, itemId: id } };
    if (item.level === 'empty') {
      rows.push({ id: nid('stockDepleted', id), kind: 'stockDepleted', occurredAt: now.toISOString(), count: 0, ...base });
    } else if (item.level === 'low') {
      rows.push({ id: nid('stockLow', id), kind: 'stockLow', occurredAt: now.toISOString(), count: item.currentStock, ...base });
    } else if (item.expiresOn && item.expiresOn <= horizon) {
      rows.push({
        id: nid('stockExpiring', id),
        kind: 'stockExpiring',
        occurredAt: iso(dayMinutesToInstant(item.expiresOn, 0, tz)),
        count: diffDays(today, item.expiresOn),
        ...base,
      });
    }
  });
  return rows;
};

/**
 * Build the feed for one detachment, already filtered to what the caller may
 * see. Rows are sorted newest `occurredAt` first (the client regroups anyway).
 *
 * @param {object} p
 * @param {object} p.tenant      SaasTenant doc
 * @param {object} p.account     Account doc (notificationPrefs, id)
 * @param {object} p.grant       normalized grant
 * @param {object} p.detachment  Detachment doc (caller holds detachment.view)
 * @param {string} p.tz
 * @param {Date}   [p.now]
 */
const feed = async ({ tenant, account, grant, detachment, tz, now = new Date() }) => {
  const tenantId = String(tenant._id);
  const detachmentId = String(detachment._id);
  const today = todayIn(tz, now);
  const prefs = (account && account.notificationPrefs) || {};
  const { attendanceGraceMinutes } = await settingsService.get();

  const stockOn = tenant.featureEnabled('inventory') && prefs.stockAlerts !== false && canIn(grant, detachmentId, 'detachment.view');
  const announcementsOn = tenant.featureEnabled('announcements') && canIn(grant, detachmentId, 'detachment.view');

  const [shifts, items, announcements, state] = await Promise.all([
    Shift.find({ tenantId, detachmentId, date: { $gte: addDays(today, -1), $lte: addDays(today, 1) } })
      .select('startsAt endsAt needed centerName attendees.attendance attendees.memberId')
      .lean(),
    stockOn ? InventoryItem.find({ tenantId, detachmentId }).select('name level currentStock expiresOn').lean() : [],
    announcementsOn ? Announcement.find({ tenantId, detachmentIds: detachmentId, publishedAt: { $lte: now } }).select('text publishedAt').lean() : [],
    stateOf(account._id),
  ]);

  const read = new Set(state.readIds);
  const cleared = new Set(state.clearedIds);

  const rows = [
    ...shiftRows(shifts, { detachmentId, grant, now, graceMs: (attendanceGraceMinutes ?? 60) * 60000, prefs }),
    ...stockRows(items, { detachmentId, now, today, tz }),
  ].map((r) => ({ ...r, isRead: read.has(r.id) }));

  announcements.forEach((a) => {
    const id = nid('announcement', a._id);
    if (cleared.has(id)) return;
    rows.push({
      id,
      kind: 'announcement',
      occurredAt: iso(a.publishedAt),
      count: 0,
      recordLabel: a.text,
      target: { type: 'announcement', announcementId: String(a._id) },
      isRead: true,
    });
  });

  rows.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id.localeCompare(b.id)));
  return rows;
};

/** Unread = rows that track read state (every kind but `announcement`) and are not read. */
const unreadCount = (rows) => rows.filter((r) => r.kind !== 'announcement' && !r.isRead).length;

/**
 * Append ids to the caller's `readIds` / `clearedIds` set atomically
 * (order-preserving de-dupe, newest last, capped at STATE_CAP newest). Unknown
 * ids — e.g. the client's own syncConflict:/syncFailed: rows — are stored.
 *
 * @param {'readIds'|'clearedIds'} field
 */
const addIds = async ({ accountId, tenantId, field, ids }) => {
  const list = [...new Set(ids.map(String))];
  const key = String(accountId);
  const exists = await NotificationState.exists({ accountId: key });
  if (!exists) {
    try {
      await NotificationState.create({ accountId: key, tenantId: String(tenantId) });
    } catch (e) {
      if (!e || e.code !== 11000) throw e; // a concurrent first write created it
    }
  }
  const literal = { $literal: list };
  const doc = await NotificationState.findOneAndUpdate(
    { accountId: key },
    [
      {
        $set: {
          [field]: {
            $slice: [
              {
                $concatArrays: [
                  { $filter: { input: { $ifNull: [`$${field}`, []] }, as: 'x', cond: { $not: [{ $in: ['$$x', literal] }] } } },
                  literal,
                ],
              },
              -STATE_CAP,
            ],
          },
        },
      },
    ],
    { new: true },
  ).lean();
  return { readIds: doc.readIds || [], clearedIds: doc.clearedIds || [] };
};

module.exports = { feed, unreadCount, stateOf, addIds, nid, STATE_CAP, STARTING_SOON_MS };
