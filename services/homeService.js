/**
 * The Today dashboard (`HomeSummary`) and the organisation overview.
 *
 * Every figure is a projection of records other endpoints serve, so a card on
 * the dashboard can never disagree with the tab it opens.
 *
 * Storage fold (the same verdict the detachment detail strip shows), worst wins:
 *   any item level `empty`                        → depleted
 *   any item level `low`                          → low
 *   any expiresOn ≤ today + 30 (expired included) → expiring
 *   otherwise                                     → healthy
 *   no items, or the inventory module disabled   → empty
 * lowStockCount     = items whose level ≠ ok
 * expiringSoonCount = items with expiresOn ≤ today + EXPIRING_SOON_DAYS
 */
const { Detachment, TeamMember, Shift, InventoryItem, Announcement, Workshop } = require('../models');
const { visibleDetachmentIds } = require('../config/capabilities');
const { EXPIRING_SOON_DAYS } = require('../config/constants');
const ser = require('./serializers');
const { todayIn, addDays, weekStartOf, dayMinutesToInstant } = require('../utils/time');

const HOME_ANNOUNCEMENT_WINDOW_MS = 60 * 60 * 1000;

/** Worst-wins storage verdict + counts over one detachment's items. */
const storageFold = (items, today) => {
  const horizon = addDays(today, EXPIRING_SOON_DAYS);
  let anyEmpty = false;
  let anyLow = false;
  let lowStockCount = 0;
  let expiringSoonCount = 0;
  (items || []).forEach((i) => {
    if (i.level === 'empty') anyEmpty = true;
    if (i.level === 'low') anyLow = true;
    if (i.level !== 'ok') lowStockCount += 1;
    if (i.expiresOn && i.expiresOn <= horizon) expiringSoonCount += 1;
  });
  let storageStatus = 'healthy';
  if (!items || !items.length) storageStatus = 'empty';
  else if (anyEmpty) storageStatus = 'depleted';
  else if (anyLow) storageStatus = 'low';
  else if (expiringSoonCount > 0) storageStatus = 'expiring';
  return { storageStatus, lowStockCount, expiringSoonCount };
};

/** Announcements shown on the Home placement right now for one detachment. */
const homeAnnouncements = (tenantId, detachmentId, now) =>
  Announcement.find({
    tenantId,
    detachmentIds: detachmentId,
    status: 'active',
    placements: 'home',
    publishedAt: { $gt: new Date(now.getTime() - HOME_ANNOUNCEMENT_WINDOW_MS), $lte: now },
    expiresAt: { $gt: now },
  }).sort({ publishedAt: -1, _id: -1 });

/**
 * @param {object} p
 * @param {object} p.tenant     SaasTenant doc
 * @param {object} p.detachment Detachment doc (already authorized)
 * @param {object} p.grant      caller grant (phoneMasked on shift attendees)
 * @param {string} p.tz
 * @param {Date}   [p.now]
 */
const summary = async ({ tenant, detachment, grant, tz, now = new Date() }) => {
  const tenantId = String(tenant._id);
  const detachmentId = String(detachment._id);
  const today = todayIn(tz, now);
  const inventoryAvailable = tenant.featureEnabled('inventory');
  const announcementsOn = tenant.featureEnabled('announcements');

  const [shiftDocs, rosterCount, items, announcements] = await Promise.all([
    Shift.find({ tenantId, detachmentId, date: { $gte: addDays(today, -1), $lte: addDays(today, 1) } }).sort({ startsAt: 1, _id: 1 }),
    TeamMember.countDocuments({ tenantId, detachmentId, active: true }),
    inventoryAvailable ? InventoryItem.find({ tenantId, detachmentId }).select('level expiresOn').lean() : [],
    announcementsOn ? homeAnnouncements(tenantId, detachmentId, now) : [],
  ]);

  const fold = inventoryAvailable ? storageFold(items, today) : { storageStatus: 'empty', lowStockCount: 0, expiringSoonCount: 0 };

  return {
    detachmentId,
    detachmentName: detachment.name,
    region: detachment.region || '',
    mainCenter: detachment.mainCenter || '',
    shifts: await ser.shifts(tenantId, shiftDocs, { grant }),
    rosterCount,
    storageStatus: fold.storageStatus,
    lowStockCount: fold.lowStockCount,
    expiringSoonCount: fold.expiringSoonCount,
    inventoryAvailable,
    announcements: announcements.map((a) => a.toJSON()),
    generatedAt: now.toISOString(),
  };
};

/**
 * Organisation-level aggregate over the caller's VISIBLE, ACTIVE detachments.
 * `workshopsThisWeek` (a count of non-archived workshops whose `at` falls in
 * the current Saturday-start week) is present only with the workshops module.
 */
const overview = async ({ tenant, grant, tz, now = new Date() }) => {
  const tenantId = String(tenant._id);
  const today = todayIn(tz, now);
  const inventoryOn = tenant.featureEnabled('inventory');

  const visible = visibleDetachmentIds(grant);
  const filter = { tenantId, status: 'active' };
  if (visible !== null) filter._id = { $in: visible };
  const dets = await Detachment.find(filter).sort({ createdAt: 1, _id: 1 }).select('_id name').lean();
  const ids = dets.map((d) => String(d._id));

  const [memberRows, shifts, items] = ids.length
    ? await Promise.all([
        TeamMember.aggregate([
          { $match: { tenantId, detachmentId: { $in: ids }, active: true } },
          { $group: { _id: '$detachmentId', n: { $sum: 1 } } },
        ]),
        Shift.find({ tenantId, detachmentId: { $in: ids }, date: today }).select('detachmentId needed attendees.memberId').lean(),
        inventoryOn ? InventoryItem.find({ tenantId, detachmentId: { $in: ids } }).select('detachmentId level expiresOn').lean() : [],
      ])
    : [[], [], []];

  const members = new Map(memberRows.map((r) => [r._id, r.n]));
  const totals = { detachments: ids.length, members: 0, todayShifts: 0, understaffedShifts: 0, lowStockItems: 0, expiringItems: 0 };

  const rows = dets.map((d) => {
    const id = String(d._id);
    const mine = shifts.filter((s) => s.detachmentId === id);
    const understaffed = mine.filter((s) => (s.attendees || []).length < s.needed).length;
    const fold = inventoryOn
      ? storageFold(
          items.filter((i) => i.detachmentId === id),
          today,
        )
      : { storageStatus: 'empty', lowStockCount: 0, expiringSoonCount: 0 };
    const rosterCount = members.get(id) || 0;

    totals.members += rosterCount;
    totals.todayShifts += mine.length;
    totals.understaffedShifts += understaffed;
    totals.lowStockItems += fold.lowStockCount;
    totals.expiringItems += fold.expiringSoonCount;

    return {
      id,
      name: d.name,
      rosterCount,
      todayShifts: mine.length,
      understaffedShifts: understaffed,
      storageStatus: fold.storageStatus,
      lowStockCount: fold.lowStockCount,
    };
  });

  const out = { generatedAt: now.toISOString(), totals, detachments: rows };
  if (tenant.featureEnabled('workshops')) {
    const weekStart = weekStartOf(today);
    out.workshopsThisWeek = await Workshop.countDocuments({
      tenantId,
      archived: { $ne: true },
      at: { $gte: dayMinutesToInstant(weekStart, 0, tz), $lt: dayMinutesToInstant(addDays(weekStart, 7), 0, tz) },
    });
  }
  return out;
};

module.exports = { storageFold, summary, overview, homeAnnouncements, HOME_ANNOUNCEMENT_WINDOW_MS };
