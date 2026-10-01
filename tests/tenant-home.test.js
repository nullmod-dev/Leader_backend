/**
 * Home: the per-detachment Today summary and the organisation overview.
 */
const f = require('./helpers/factory');
const { todayIn, addDays } = require('../utils/time');

const { Announcement, Workshop } = f.models;

const TZ = 'Asia/Damascus';
let tenant;
let main;
const A = () => f.auth(main.token);
const tid = () => String(tenant._id);

const setFeature = (t, key, enabled) => f.models.SaasTenant.updateOne({ _id: t._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled } });
const summaryOf = (det, auth = A()) => f.api().get('/api/v1/home/summary').query({ detachmentId: String(det._id) }).set(auth);

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
});

describe('GET /home/summary', () => {
  test('shape: shifts yesterday..tomorrow sorted by start, rosterCount of active members', async () => {
    const det = await f.detachment(tenant, null, { name: 'مفرزة الصالحية', region: 'دمشق', mainCenter: 'مركز الصالحية' });
    const today = todayIn(TZ);
    await f.shift(tenant, det, { date: addDays(today, 1), startMinutes: 60, endMinutes: 120 });
    await f.shift(tenant, det, { date: today, startMinutes: 600, endMinutes: 720 });
    await f.shift(tenant, det, { date: addDays(today, -1), startMinutes: 1200, endMinutes: 120 }); // crosses midnight
    await f.shift(tenant, det, { date: addDays(today, -2) }); // outside the window
    await f.shift(tenant, det, { date: addDays(today, 2) }); // outside the window
    const m = await f.member(tenant, det);
    await f.member(tenant, det);
    await f.member(tenant, det, { active: false });

    const res = await summaryOf(det).expect(200);
    expect(res.body).toMatchObject({
      detachmentId: String(det._id),
      detachmentName: 'مفرزة الصالحية',
      region: 'دمشق',
      mainCenter: 'مركز الصالحية',
      rosterCount: 2,
      storageStatus: 'empty',
      lowStockCount: 0,
      expiringSoonCount: 0,
      inventoryAvailable: true,
      announcements: [],
    });
    expect(res.body.generatedAt).toMatch(/Z$/);
    expect(res.body.shifts.map((s) => s.date)).toEqual([addDays(today, -1), today, addDays(today, 1)]);
    expect(res.body.shifts[0]).toMatchObject({ crossesMidnight: true, assigned: 0, hasCoverageGap: true });
    expect(m).toBeDefined();
  });

  test('storageStatus worst-wins with counts', async () => {
    const today = todayIn(TZ);
    const cases = [
      { items: [{}], status: 'healthy', low: 0, exp: 0 },
      { items: [{}, { expiresOn: addDays(today, 10) }], status: 'expiring', low: 0, exp: 1 },
      { items: [{ expiresOn: addDays(today, -3) }], status: 'expiring', low: 0, exp: 1 },
      { items: [{ expiresOn: addDays(today, 31) }], status: 'healthy', low: 0, exp: 0 },
      { items: [{ currentStock: 2 }, { expiresOn: addDays(today, 30) }], status: 'low', low: 1, exp: 1 },
      { items: [{ currentStock: 0 }, { currentStock: 1 }], status: 'depleted', low: 2, exp: 0 },
    ];
    for (const c of cases) {
      // eslint-disable-next-line no-await-in-loop
      const det = await f.detachment(tenant);
      // eslint-disable-next-line no-await-in-loop
      for (const it of c.items) await f.inventoryItem(tenant, det, it);
      // eslint-disable-next-line no-await-in-loop
      const res = await summaryOf(det).expect(200);
      expect({ s: res.body.storageStatus, low: res.body.lowStockCount, exp: res.body.expiringSoonCount }).toEqual({ s: c.status, low: c.low, exp: c.exp });
    }
  });

  test('home announcements: active, home placement, < 1 h old, not expired, addressed here', async () => {
    const det = await f.detachment(tenant);
    const other = await f.detachment(tenant);
    const now = Date.now();
    const mk = (over) =>
      Announcement.create({
        tenantId: tid(),
        text: 'تنبيه للمفرزة عن المناوبة',
        detachmentIds: [String(det._id)],
        placements: ['notifications', 'home'],
        publishedAt: new Date(now - 10 * 60000),
        expiresAt: new Date(now + 86400000),
        ...over,
      });
    const shown = await mk({});
    await mk({ publishedAt: new Date(now - 2 * 3600000) }); // too old for Home
    await mk({ placements: ['notifications'] }); // not on Home
    await mk({ status: 'withdrawn' });
    await mk({ expiresAt: new Date(now - 1000), publishedAt: new Date(now - 20 * 60000) });
    await mk({ detachmentIds: [String(other._id)] });

    const res = await summaryOf(det).expect(200);
    expect(res.body.announcements.map((a) => a.id)).toEqual([String(shown._id)]);
    expect(res.body.announcements[0]).toMatchObject({ text: 'تنبيه للمفرزة عن المناوبة', status: 'active' });
    expect(res.body.announcements[0].publishedAt).toMatch(/Z$/);
  });

  test('modules off: inventory → storage empty + inventoryAvailable false; announcements → none', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const det = await f.detachment(t2);
    await f.inventoryItem(t2, det, { currentStock: 0 });
    await Announcement.create({
      tenantId: String(t2._id),
      text: 'إعلان لن يظهر',
      detachmentIds: [String(det._id)],
      placements: ['home'],
      publishedAt: new Date(Date.now() - 60000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    await setFeature(t2, 'inventory', false);
    await setFeature(t2, 'announcements', false);
    const res = await summaryOf(det, f.auth(m2.token)).expect(200);
    expect(res.body).toMatchObject({ storageStatus: 'empty', lowStockCount: 0, expiringSoonCount: 0, inventoryAvailable: false, announcements: [] });
  });

  test('refusals: missing detachmentId → 422; unknown → 404; not visible → 403', async () => {
    const det = await f.detachment(tenant);
    const missing = await f.api().get('/api/v1/home/summary').set(A()).expect(422);
    expect(missing.body.error.fields.detachmentId).toBeDefined();
    const unknown = await f.api().get('/api/v1/home/summary').query({ detachmentId: 'd_nope' }).set(A()).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
    const stranger = await f.simpleAdmin(tenant, { global: [], scoped: { d_elsewhere: ['member.view'] } });
    const denied = await summaryOf(det, f.auth(stranger.token)).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
  });

  test('super_admin → 403 tenant_context_unavailable', async () => {
    const sa = await f.superAdmin();
    const res = await f.api().get('/api/v1/home/overview').set(f.auth(sa.token)).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
  });
});

describe('GET /home/overview', () => {
  test('aggregates visible ACTIVE detachments; workshopsThisWeek with the module', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const today = todayIn(TZ);
    const g = await f.group(t2);
    const a = await f.detachment(t2, g, { name: 'أ' });
    const b = await f.detachment(t2, g, { name: 'ب' });
    await f.detachment(t2, g, { name: 'مؤرشفة', status: 'archived' });

    const ma = await f.member(t2, a);
    await f.member(t2, a);
    await f.member(t2, b);
    await f.shift(t2, a, { needed: 1, attendees: [{ memberId: ma._id }] });
    await f.shift(t2, a, { needed: 2, startMinutes: 900, endMinutes: 1000 });
    await f.shift(t2, b, { needed: 1 });
    await f.shift(t2, b, { date: addDays(today, 1) }); // not today
    await f.inventoryItem(t2, a, { currentStock: 1 }); // low
    await f.inventoryItem(t2, b, { expiresOn: addDays(today, 5) }); // expiring

    await f.workshop(t2, { at: new Date() });
    await f.workshop(t2, { at: new Date(), archived: true });
    await f.workshop(t2, { at: new Date(Date.now() + 30 * 86400000) });

    const res = await f.api().get('/api/v1/home/overview').set(f.auth(m2.token)).expect(200);
    expect(res.body.totals).toEqual({ detachments: 2, members: 3, todayShifts: 3, understaffedShifts: 2, lowStockItems: 1, expiringItems: 1 });
    expect(res.body.detachments).toEqual([
      { id: String(a._id), name: 'أ', rosterCount: 2, todayShifts: 2, understaffedShifts: 1, storageStatus: 'low', lowStockCount: 1 },
      { id: String(b._id), name: 'ب', rosterCount: 1, todayShifts: 1, understaffedShifts: 1, storageStatus: 'expiring', lowStockCount: 0 },
    ]);
    expect(res.body.workshopsThisWeek).toBe(1);
    expect(res.body.generatedAt).toMatch(/Z$/);

    const scoped = await f.simpleAdmin(t2, { global: [], scoped: { [b._id]: ['member.view'] } });
    const mine = await f.api().get('/api/v1/home/overview').set(f.auth(scoped.token)).expect(200);
    expect(mine.body.detachments.map((d) => d.id)).toEqual([String(b._id)]);
    expect(mine.body.totals.members).toBe(1);

    await setFeature(t2, 'workshops', false);
    const noWs = await f.api().get('/api/v1/home/overview').set(f.auth(m2.token)).expect(200);
    expect(noWs.body.workshopsThisWeek).toBeUndefined();
    expect(Workshop).toBeDefined();
  });
});
