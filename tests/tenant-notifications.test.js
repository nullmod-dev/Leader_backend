/**
 * Notifications Center: derivation (shifts, stock, announcements), capability
 * filtering, preferences, read / cleared state, unread count.
 */
const { DateTime } = require('luxon');
const f = require('./helpers/factory');
const { todayIn, addDays } = require('../utils/time');

const { Announcement, Account, NotificationState } = f.models;

const TZ = 'Asia/Damascus';
const MIN = 60000;
let tenant;
let main;
const A = () => f.auth(main.token);
const tid = () => String(tenant._id);

const setFeature = (t, key, enabled) => f.models.SaasTenant.updateOne({ _id: t._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled } });

/** A shift whose window is [start, end] (minute precision, tenant tz). */
const shiftBetween = (t, det, start, end, extra = {}) => {
  const s = DateTime.fromJSDate(start).setZone(TZ);
  const e = DateTime.fromJSDate(end).setZone(TZ);
  return f.shift(t, det, { date: s.toISODate(), startMinutes: s.hour * 60 + s.minute, endMinutes: e.hour * 60 + e.minute, ...extra });
};

const feedOf = async (det, auth = A()) => {
  const res = await f.api().get('/api/v1/notifications').query({ detachmentId: String(det._id) }).set(auth).expect(200);
  return res.body.notifications;
};
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
});

describe('shift-derived rows', () => {
  let det;
  let ended;
  let soon;
  let longAgo;
  let later;

  beforeAll(async () => {
    det = await f.detachment(tenant);
    const m1 = await f.member(tenant, det);
    const m2 = await f.member(tenant, det);
    const now = Date.now();
    // ended 30 min ago, one attendee still notCheckedIn → shiftAttendanceMissing (grace 60)
    ended = await shiftBetween(tenant, det, new Date(now - 180 * MIN), new Date(now - 30 * MIN), {
      needed: 5,
      centerName: 'مركز المالكي',
      attendees: [
        { memberId: m1._id, attendance: 'notCheckedIn' },
        { memberId: m2._id, attendance: 'checkedIn' },
      ],
    });
    // starts in 2 h, 1 of 3 → shiftUnderstaffed (gap 2) + shiftStartingSoon
    soon = await shiftBetween(tenant, det, new Date(now + 120 * MIN), new Date(now + 300 * MIN), {
      needed: 3,
      centerName: 'مركز الميدان',
      attendees: [{ memberId: m1._id }],
    });
    // ended 2 h ago → outside the grace window
    longAgo = await shiftBetween(tenant, det, new Date(now - 300 * MIN), new Date(now - 120 * MIN), {
      attendees: [{ memberId: m1._id, attendance: 'notCheckedIn' }],
    });
    // starts in 8 h, fully staffed → nothing
    later = await shiftBetween(tenant, det, new Date(now + 480 * MIN), new Date(now + 600 * MIN), {
      needed: 1,
      attendees: [{ memberId: m2._id }],
    });
  });

  test('main admin sees understaffed, attendance missing and starting soon', async () => {
    const rows = byId(await feedOf(det));
    expect(rows.get(`shiftAttendanceMissing:${ended._id}`)).toMatchObject({
      kind: 'shiftAttendanceMissing',
      count: 1,
      recordLabel: 'مركز المالكي',
      occurredAt: ended.endsAt.toISOString(),
      target: { type: 'shift', detachmentId: String(det._id), shiftId: String(ended._id) },
      isRead: false,
    });
    expect(rows.get(`shiftUnderstaffed:${soon._id}`)).toMatchObject({ count: 2, occurredAt: soon.startsAt.toISOString(), recordLabel: 'مركز الميدان' });
    expect(rows.get(`shiftStartingSoon:${soon._id}`)).toMatchObject({ count: 0, occurredAt: soon.startsAt.toISOString() });
    // finished shifts are no longer understaffed; outside grace nothing is missing; >6 h is not "soon"
    expect(rows.has(`shiftUnderstaffed:${ended._id}`)).toBe(false);
    expect(rows.has(`shiftAttendanceMissing:${longAgo._id}`)).toBe(false);
    expect(rows.has(`shiftStartingSoon:${later._id}`)).toBe(false);
    expect(rows.has(`shiftUnderstaffed:${later._id}`)).toBe(false);
  });

  test('capability filtering: detachment.view only → starting soon only', async () => {
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    const kinds = (await feedOf(det, f.auth(viewer.token))).map((r) => r.kind);
    expect(kinds).toContain('shiftStartingSoon');
    expect(kinds).not.toContain('shiftUnderstaffed');
    expect(kinds).not.toContain('shiftAttendanceMissing');

    const assigner = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.assign'] } });
    const k2 = (await feedOf(det, f.auth(assigner.token))).map((r) => r.kind);
    expect(k2).toContain('shiftUnderstaffed');
    expect(k2).not.toContain('shiftAttendanceMissing');

    const recorder = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.attendance.record'] } });
    const k3 = (await feedOf(det, f.auth(recorder.token))).map((r) => r.kind);
    expect(k3).toContain('shiftAttendanceMissing');
    expect(k3).not.toContain('shiftUnderstaffed');
  });

  test('grace window follows attendanceGraceMinutes', async () => {
    await f.setSettings({ attendanceGraceMinutes: 20 });
    try {
      const rows = byId(await feedOf(det));
      expect(rows.has(`shiftAttendanceMissing:${ended._id}`)).toBe(false);
    } finally {
      await f.setSettings({ attendanceGraceMinutes: 60 });
    }
  });

  test('prefs.shiftReminders = false drops shiftStartingSoon only', async () => {
    const quiet = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.manage'] } });
    await Account.updateOne({ _id: quiet.account._id }, { $set: { 'notificationPrefs.shiftReminders': false } });
    const kinds = (await feedOf(det, f.auth(quiet.token))).map((r) => r.kind);
    expect(kinds).not.toContain('shiftStartingSoon');
    expect(kinds).toContain('shiftUnderstaffed');
  });
});

describe('stock-derived rows', () => {
  test('one row per item, worst wins; expiry counts days left (negative once expired)', async () => {
    const det = await f.detachment(tenant);
    const today = todayIn(TZ);
    const empty = await f.inventoryItem(tenant, det, { name: 'محلول ملحي', currentStock: 0, expiresOn: addDays(today, 3) });
    const low = await f.inventoryItem(tenant, det, { name: 'ضماد', currentStock: 3, minimum: 5, expiresOn: addDays(today, 3) });
    const soon = await f.inventoryItem(tenant, det, { name: 'مطهر', expiresOn: addDays(today, 10) });
    const expired = await f.inventoryItem(tenant, det, { name: 'مسكن', expiresOn: addDays(today, -2) });
    const fine = await f.inventoryItem(tenant, det, { name: 'قطن', expiresOn: addDays(today, 60) });

    const rows = await feedOf(det);
    const map = byId(rows);
    expect(map.get(`stockDepleted:${empty._id}`)).toMatchObject({ count: 0, recordLabel: 'محلول ملحي', target: { type: 'storage', detachmentId: String(det._id), itemId: String(empty._id) } });
    expect(map.get(`stockLow:${low._id}`)).toMatchObject({ count: 3, recordLabel: 'ضماد' });
    expect(map.get(`stockExpiring:${soon._id}`)).toMatchObject({ count: 10 });
    expect(map.get(`stockExpiring:${soon._id}`).occurredAt).toBe(new Date(DateTime.fromISO(addDays(today, 10), { zone: TZ }).toMillis()).toISOString());
    expect(map.get(`stockExpiring:${expired._id}`)).toMatchObject({ count: -2 });
    expect(rows.filter((r) => r.recordLabel === 'محلول ملحي')).toHaveLength(1);
    expect(rows.filter((r) => r.recordLabel === 'ضماد')).toHaveLength(1);
    expect(rows.some((r) => r.target && r.target.itemId === String(fine._id))).toBe(false);
  });

  test('prefs.stockAlerts = false or inventory module off → no stock rows', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const det = await f.detachment(t2);
    await f.inventoryItem(t2, det, { currentStock: 0 });
    expect((await feedOf(det, f.auth(m2.token))).map((r) => r.kind)).toEqual(['stockDepleted']);
    await Account.updateOne({ _id: m2.account._id }, { $set: { 'notificationPrefs.stockAlerts': false } });
    expect(await feedOf(det, f.auth(m2.token))).toEqual([]);
    await Account.updateOne({ _id: m2.account._id }, { $set: { 'notificationPrefs.stockAlerts': true } });
    await setFeature(t2, 'inventory', false);
    expect(await feedOf(det, f.auth(m2.token))).toEqual([]);
  });
});

describe('announcement rows + read / cleared state', () => {
  let det;
  let active;
  let withdrawn;
  let understaffed;

  beforeAll(async () => {
    det = await f.detachment(tenant);
    const now = Date.now();
    const base = { tenantId: tid(), text: 'اجتماع المفرزة مساء اليوم', detachmentIds: [String(det._id)], expiresAt: new Date(now + 86400000) };
    active = await Announcement.create({ ...base, publishedAt: new Date(now - 5 * MIN) });
    withdrawn = await Announcement.create({ ...base, publishedAt: new Date(now - 50 * MIN), status: 'withdrawn' });
    await Announcement.create({ ...base, publishedAt: new Date(now + 60 * MIN) }); // not yet published
    await Announcement.create({ ...base, detachmentIds: ['d_elsewhere'], publishedAt: new Date(now - MIN) });
    understaffed = await shiftBetween(tenant, det, new Date(now + 30 * MIN), new Date(now + 90 * MIN), { needed: 2 });
  });

  test('announcements (any status) are rows, always read', async () => {
    const rows = await feedOf(det);
    const ann = rows.filter((r) => r.kind === 'announcement');
    expect(ann.map((r) => r.id).sort()).toEqual([`announcement:${active._id}`, `announcement:${withdrawn._id}`].sort());
    expect(ann[0]).toMatchObject({ count: 0, isRead: true, recordLabel: 'اجتماع المفرزة مساء اليوم' });
    expect(byId(ann).get(`announcement:${active._id}`)).toMatchObject({
      occurredAt: active.publishedAt.toISOString(),
      target: { type: 'announcement', announcementId: String(active._id) },
    });
  });

  test('read ids: stored (unknown ids too), reflected on the feed and the unread count', async () => {
    const count0 = await f.api().get('/api/v1/notifications/unread-count').query({ detachmentId: String(det._id) }).set(A()).expect(200);
    expect(count0.body.count).toBe(2); // understaffed + starting soon; announcements never count

    const id = `shiftUnderstaffed:${understaffed._id}`;
    const res = await f.api().put('/api/v1/notifications/read').set(A()).send({ ids: [id, 'syncConflict:op_1', id] }).expect(200);
    expect(res.body.readIds).toEqual([id, 'syncConflict:op_1']);
    const again = await f.api().put('/api/v1/notifications/read').set(A()).send({ ids: ['syncFailed:op_2', id] }).expect(200);
    expect(again.body.readIds).toEqual(['syncConflict:op_1', 'syncFailed:op_2', id]);

    expect(byId(await feedOf(det)).get(id).isRead).toBe(true);
    const count1 = await f.api().get('/api/v1/notifications/unread-count').query({ detachmentId: String(det._id) }).set(A()).expect(200);
    expect(count1.body.count).toBe(1);
  });

  test('cleared ids drop announcement rows; GET /state returns both sets', async () => {
    const annId = `announcement:${withdrawn._id}`;
    const res = await f.api().put('/api/v1/notifications/cleared').set(A()).send({ ids: [annId] }).expect(200);
    expect(res.body.clearedIds).toEqual([annId]);
    const rows = await feedOf(det);
    expect(rows.some((r) => r.id === annId)).toBe(false);
    expect(rows.some((r) => r.id === `announcement:${active._id}`)).toBe(true);
    const state = await f.api().get('/api/v1/notifications/state').set(A()).expect(200);
    expect(state.body.clearedIds).toEqual([annId]);
    expect(state.body.readIds).toContain('syncConflict:op_1');
  });

  test('state is per account', async () => {
    const other = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.manage'] } });
    const state = await f.api().get('/api/v1/notifications/state').set(f.auth(other.token)).expect(200);
    expect(state.body).toEqual({ readIds: [], clearedIds: [] });
  });

  test('the read set is capped at the 5000 newest ids', async () => {
    const acc = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    const auth = f.auth(acc.token);
    for (let batch = 0; batch < 11; batch += 1) {
      const ids = Array.from({ length: 500 }, (_, i) => `stockLow:i_${batch}_${i}`);
      // eslint-disable-next-line no-await-in-loop
      await f.api().put('/api/v1/notifications/read').set(auth).send({ ids }).expect(200);
    }
    const st = await NotificationState.findOne({ accountId: String(acc.account._id) });
    expect(st.readIds).toHaveLength(5000);
    expect(st.readIds[0]).toBe('stockLow:i_1_0');
    expect(st.readIds[4999]).toBe('stockLow:i_10_499');
  });

  test('validation: ids required, 1..500', async () => {
    await f.api().put('/api/v1/notifications/read').set(A()).send({}).expect(422);
    await f.api().put('/api/v1/notifications/read').set(A()).send({ ids: [] }).expect(422);
    const tooMany = Array.from({ length: 501 }, (_, i) => `x:${i}`);
    await f.api().put('/api/v1/notifications/read').set(A()).send({ ids: tooMany }).expect(422);
    await f.api().put('/api/v1/notifications/cleared').set(A()).send({ ids: 'nope' }).expect(422);
  });

  test('ids that look like operators are stored literally', async () => {
    const res = await f.api().put('/api/v1/notifications/read').set(A()).send({ ids: ['$readIds', '$$ROOT'] }).expect(200);
    expect(res.body.readIds).toEqual(expect.arrayContaining(['$readIds', '$$ROOT']));
  });

  test('announcements module off → no announcement rows', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const d2 = await f.detachment(t2);
    await Announcement.create({ tenantId: String(t2._id), text: 'إعلان مخفي', detachmentIds: [String(d2._id)], publishedAt: new Date(Date.now() - MIN), expiresAt: new Date(Date.now() + 3600000) });
    expect((await feedOf(d2, f.auth(m2.token))).map((r) => r.kind)).toEqual(['announcement']);
    await setFeature(t2, 'announcements', false);
    expect(await feedOf(d2, f.auth(m2.token))).toEqual([]);
  });
});

describe('refusals', () => {
  test('missing detachmentId → 422; unknown → 404; not visible → 403; super_admin → 403', async () => {
    const det = await f.detachment(tenant);
    await f.api().get('/api/v1/notifications').set(A()).expect(422);
    await f.api().get('/api/v1/notifications/unread-count').set(A()).expect(422);
    const unknown = await f.api().get('/api/v1/notifications').query({ detachmentId: 'd_nope' }).set(A()).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
    const stranger = await f.simpleAdmin(tenant, { global: [], scoped: { d_elsewhere: ['shift.manage'] } });
    const denied = await f.api().get('/api/v1/notifications').query({ detachmentId: String(det._id) }).set(f.auth(stranger.token)).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
    const sa = await f.superAdmin();
    const res = await f.api().get('/api/v1/notifications/state').set(f.auth(sa.token)).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
  });
});
