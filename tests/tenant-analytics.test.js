/**
 * /tenant/analytics/** — formulas on a known fixture, stats.view scoping,
 * feature gates and range validation.
 *
 * Fixture (tenant tz Asia/Damascus, T = today):
 *   A (3 active members a1 a2 a3 + 1 inactive), B (b1 b2), C archived.
 *   S1  A  T-1  needed 3  a1 checkedOut · a2 checkedIn · a3 absent   center الشعلان
 *   S2  A  T-2  needed 2  a1 checkedIn  · a2 notCheckedIn (ended)    center المزة
 *   S3  B  T-1  needed 4  b1 absent
 *   S4  A  T-40 needed 2  a1 checkedIn                               (outside default range)
 *   → Σneeded 9, Σfilled 6 → coverage 67; present 3 / resolved 5 → attendance 60.
 */
const f = require('./helpers/factory');
const { todayIn, addDays, dayMinutesToInstant } = require('../utils/time');

const TZ = 'Asia/Damascus';
const get = (token, path) => f.api().get(`/api/v1/tenant/analytics${path}`).set(f.auth(token));

const build = async (tenantOverrides) => {
  const { tenant, main } = await f.tenantWithMainAdmin(tenantOverrides);
  const T = todayIn(TZ);
  const tid = String(tenant._id);
  const A = await f.detachment(tenant, null, { name: 'مفرزة ألف' });
  const B = await f.detachment(tenant, null, { name: 'مفرزة باء' });
  const C = await f.detachment(tenant, null, { name: 'مفرزة مؤرشفة', status: 'archived' });
  const a1 = await f.member(tenant, A, { name: 'أحمد الأول' });
  const a2 = await f.member(tenant, A, { name: 'باسل الثاني' });
  const a3 = await f.member(tenant, A, { name: 'جميل الثالث' });
  await f.member(tenant, A, { name: 'غير نشط', active: false });
  const b1 = await f.member(tenant, B, { name: 'دانة باء' });
  await f.member(tenant, B, { name: 'هادي باء' });
  await f.member(tenant, C, { name: 'مؤرشف' });

  const at = (m, attendance) => ({ memberId: String(m._id), attendance });
  await f.shift(tenant, A, { date: addDays(T, -1), needed: 3, centerName: 'مركز الشعلان', attendees: [at(a1, 'checkedOut'), at(a2, 'checkedIn'), at(a3, 'absent')] });
  await f.shift(tenant, A, { date: addDays(T, -2), needed: 2, centerName: 'مركز المزة', attendees: [at(a1, 'checkedIn'), at(a2, 'notCheckedIn')] });
  await f.shift(tenant, B, { date: addDays(T, -1), needed: 4, attendees: [at(b1, 'absent')] });
  await f.shift(tenant, A, { date: addDays(T, -40), needed: 2, attendees: [at(a1, 'checkedIn')] });

  // Inventory: A ok+expiring, A low; B empty.
  const item1 = await f.inventoryItem(tenant, A, { name: 'شاش معقم', currentStock: 20, minimum: 5, expiresOn: addDays(T, 10) });
  await f.inventoryItem(tenant, A, { name: 'قفازات', currentStock: 2, minimum: 5 });
  const item3 = await f.inventoryItem(tenant, B, { name: 'ضمادات', currentStock: 0, minimum: 5 });
  const mv = (item, det, direction, qty, day) =>
    f.models.InventoryMovement.create({
      tenantId: tid,
      detachmentId: String(det._id),
      itemId: String(item._id),
      direction,
      quantity: qty,
      convertedBaseUnitQuantity: qty,
      at: dayMinutesToInstant(day, 720, TZ),
    });
  await mv(item1, A, 'inflow', 10, addDays(T, -1));
  await mv(item1, A, 'outflow', 3, addDays(T, -1));
  await mv(item3, B, 'outflow', 5, addDays(T, -2));

  // Workshops (organisation-level).
  const wAt = (day) => dayMinutesToInstant(day, 600, TZ);
  const w1 = await f.workshop(tenant, { at: wAt(addDays(T, -3)), status: 'done', registrationFee: 25000 });
  const w2 = await f.workshop(tenant, { at: wAt(addDays(T, 4)), status: 'scheduled', registrationFee: 25000 });
  const w4 = await f.workshop(tenant, { at: wAt(addDays(T, -1)), status: 'done', registrationFee: 0 });
  await f.workshop(tenant, { at: wAt(addDays(T, -5)), archived: true });
  const p = (w, attendance, paymentStatus) =>
    f.models.WorkshopParticipant.create({ tenantId: tid, workshopId: String(w._id), name: `ضيف ${f.uniq()}`, kind: 'guest', attendance, paymentStatus });
  await p(w1, 'checkedIn', 'paid');
  await p(w1, 'absent', 'unpaid');
  await p(w1, 'notCheckedIn', null);
  await p(w2, 'notCheckedIn', 'paid');
  await p(w4, 'checkedIn', null);

  // Announcements: one active for A, one active for B, one expired, one withdrawn.
  const now = Date.now();
  const ann = (dets, extra = {}) =>
    f.models.Announcement.create({
      tenantId: tid,
      text: 'تنبيه تشغيلي للمفرزة',
      detachmentIds: dets.map((d) => String(d._id)),
      publishedAt: new Date(now - 3600000),
      expiresAt: new Date(now + 86400000),
      ...extra,
    });
  await ann([A]);
  await ann([B]);
  await ann([A], { expiresAt: new Date(now - 1000) });
  await ann([A, B], { status: 'withdrawn' });

  const scoped = await f.simpleAdmin(tenant, { global: [], scoped: { [String(A._id)]: ['stats.view', 'detachment.view'] } });
  return { tenant, main, scoped, T, A, B, C, a1, a2, a3, b1, item1 };
};

describe('GET /tenant/analytics/dashboard', () => {
  let fx;
  beforeAll(async () => {
    fx = await build();
  });

  test('KPI formulas over the default 30-day range (main admin = every active detachment)', async () => {
    const res = await get(fx.main.token, '/dashboard').expect(200);
    expect(res.body.range).toEqual({ from: addDays(fx.T, -29), to: fx.T });
    expect(res.body.kpis).toEqual({
      detachments: 2,
      members: 5,
      shifts: 3,
      neededSlots: 9,
      filledSlots: 6,
      coveragePercent: 67,
      attendancePercent: 60,
      absences: 2,
      workshops: 2,
      workshopAttendancePercent: 67,
      lowStockItems: 2,
      expiringItems: 1,
      activeAnnouncements: 2,
    });
    expect(typeof res.body.generatedAt).toBe('string');
  });

  test('daily series, per-detachment rows and top members', async () => {
    const { body } = await get(fx.main.token, '/dashboard').expect(200);
    expect(body.series.coverage).toHaveLength(30);
    const day = (list, d) => list.find((x) => x.date === d);
    expect(day(body.series.coverage, addDays(fx.T, -1))).toEqual({ date: addDays(fx.T, -1), percent: 57 });
    expect(day(body.series.coverage, addDays(fx.T, -2)).percent).toBe(100);
    expect(day(body.series.coverage, addDays(fx.T, -5)).percent).toBe(0);
    expect(day(body.series.attendance, addDays(fx.T, -1)).percent).toBe(50);
    expect(day(body.series.stockMovements, addDays(fx.T, -1))).toEqual({ date: addDays(fx.T, -1), inflow: 10, outflow: 3 });
    expect(day(body.series.stockMovements, addDays(fx.T, -2))).toEqual({ date: addDays(fx.T, -2), inflow: 0, outflow: 5 });

    expect(body.byDetachment).toEqual([
      { detachmentId: String(fx.A._id), name: 'مفرزة ألف', shifts: 2, coveragePercent: 100, attendancePercent: 75, members: 3, storageStatus: 'low' },
      { detachmentId: String(fx.B._id), name: 'مفرزة باء', shifts: 1, coveragePercent: 25, attendancePercent: 0, members: 2, storageStatus: 'depleted' },
    ]);
    expect(body.topMembers.slice(0, 2)).toEqual([
      { memberId: String(fx.a1._id), name: 'أحمد الأول', detachmentId: String(fx.A._id), attended: 2, absent: 0, attendancePercent: 100 },
      { memberId: String(fx.a2._id), name: 'باسل الثاني', detachmentId: String(fx.A._id), attended: 1, absent: 0, attendancePercent: 100 },
    ]);
    expect(body.topMembers).toHaveLength(4);
  });

  test('an explicit range reaches older shifts', async () => {
    const { body } = await get(fx.main.token, `/dashboard?from=${addDays(fx.T, -45)}&to=${fx.T}`).expect(200);
    expect(body.kpis.shifts).toBe(4);
    expect(body.series.coverage).toHaveLength(46);
  });

  test('a scoped admin only sees the detachments where it holds stats.view', async () => {
    const { body } = await get(fx.scoped.token, '/dashboard').expect(200);
    expect(body.kpis).toMatchObject({
      detachments: 1,
      members: 3,
      shifts: 2,
      neededSlots: 5,
      filledSlots: 5,
      coveragePercent: 100,
      attendancePercent: 75,
      absences: 1,
      lowStockItems: 1,
      expiringItems: 1,
      activeAnnouncements: 1,
    });
    expect(body.byDetachment.map((d) => d.detachmentId)).toEqual([String(fx.A._id)]);
    expect(body.topMembers.every((m) => m.detachmentId === String(fx.A._id))).toBe(true);
    const outflow = body.series.stockMovements.reduce((a, d) => a + d.outflow, 0);
    expect(outflow).toBe(3);
  });

  test('range validation → 422', async () => {
    const r1 = await get(fx.main.token, `/dashboard?from=${fx.T}&to=${addDays(fx.T, -1)}`).expect(422);
    expect(r1.body.error.fields).toHaveProperty('from');
    const r2 = await get(fx.main.token, '/dashboard?from=2026-13-01').expect(422);
    expect(r2.body.error.fields).toHaveProperty('from');
    const r3 = await get(fx.main.token, `/dashboard?from=${addDays(fx.T, -366)}&to=${fx.T}`).expect(422);
    expect(r3.body.error.fields).toHaveProperty('range');
    await get(fx.main.token, `/dashboard?from=${addDays(fx.T, -365)}&to=${fx.T}`).expect(200);
    await get(fx.main.token, '/dashboard?to=yesterday').expect(422);
  });

  test('without stats.view anywhere → 403 not_permitted', async () => {
    const plain = await f.simpleAdmin(fx.tenant, { global: ['member.view'], scoped: {} });
    const res = await get(plain.token, '/dashboard').expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    await f.api().get('/api/v1/tenant/analytics/dashboard').expect(401);
  });
});

describe('module gates', () => {
  test('statistics_reports off → 403 feature_disabled (before the capability check)', async () => {
    const tenant = await f.createTenant({
      features: [
        { key: 'inventory', enabled: true },
        { key: 'statistics_reports', enabled: false },
        { key: 'workshops', enabled: true },
        { key: 'announcements', enabled: true },
      ],
    });
    const main = await f.mainAdmin(tenant);
    const plain = await f.simpleAdmin(tenant, { global: [], scoped: {} });
    for (const path of ['/dashboard', '/workshops', '/inventory', '/detachments/d_x']) {
      const res = await get(main.token, path).expect(403);
      expect(res.body.error).toMatchObject({ code: 'feature_disabled', feature: 'statistics_reports' });
    }
    const res = await get(plain.token, '/dashboard').expect(403);
    expect(res.body.error.code).toBe('feature_disabled');
  });

  test('inventory / workshops / announcements off → their figures disappear, their reports refuse', async () => {
    const tenant = await f.createTenant({
      features: [
        { key: 'inventory', enabled: false },
        { key: 'statistics_reports', enabled: true },
        { key: 'workshops', enabled: false },
        { key: 'announcements', enabled: false },
      ],
    });
    const main = await f.mainAdmin(tenant);
    const det = await f.detachment(tenant);
    await f.inventoryItem(tenant, det, { currentStock: 0 });
    const { body } = await get(main.token, '/dashboard').expect(200);
    ['workshops', 'workshopAttendancePercent', 'lowStockItems', 'expiringItems', 'activeAnnouncements'].forEach((k) =>
      expect(body.kpis).not.toHaveProperty(k),
    );
    expect(body.series).not.toHaveProperty('stockMovements');
    expect(body.byDetachment[0]).not.toHaveProperty('storageStatus');
    const w = await get(main.token, '/workshops').expect(403);
    expect(w.body.error).toMatchObject({ code: 'feature_disabled', feature: 'workshops' });
    const i = await get(main.token, '/inventory').expect(403);
    expect(i.body.error).toMatchObject({ code: 'feature_disabled', feature: 'inventory' });
  });
});

describe('GET /tenant/analytics/detachments/:detachmentId', () => {
  let fx;
  beforeAll(async () => {
    fx = await build();
  });

  test('members (with pending), centers, kpis for one detachment', async () => {
    const { body } = await get(fx.main.token, `/detachments/${fx.A._id}`).expect(200);
    expect(body.detachment).toEqual({ id: String(fx.A._id), name: 'مفرزة ألف' });
    expect(body.kpis).toMatchObject({
      members: 3,
      shifts: 2,
      neededSlots: 5,
      filledSlots: 5,
      coveragePercent: 100,
      attendancePercent: 75,
      absences: 1,
      lowStockItems: 1,
      expiringItems: 1,
      storageStatus: 'low',
      activeAnnouncements: 1,
    });
    expect(body.members).toEqual([
      { memberId: String(fx.a1._id), name: 'أحمد الأول', role: 'member', shifts: 2, attended: 2, absent: 0, pending: 0, attendancePercent: 100 },
      { memberId: String(fx.a2._id), name: 'باسل الثاني', role: 'member', shifts: 2, attended: 1, absent: 0, pending: 1, attendancePercent: 100 },
      { memberId: String(fx.a3._id), name: 'جميل الثالث', role: 'member', shifts: 1, attended: 0, absent: 1, pending: 0, attendancePercent: 0 },
    ]);
    expect(body.centers).toEqual(
      expect.arrayContaining([
        { centerName: 'مركز الشعلان', shifts: 1, coveragePercent: 100 },
        { centerName: 'مركز المزة', shifts: 1, coveragePercent: 100 },
      ]),
    );
    expect(body.series.coverage.find((d) => d.date === addDays(fx.T, -1)).percent).toBe(100);
  });

  test('scoped admin: own detachment ok, another → 403, unknown → 404', async () => {
    await get(fx.scoped.token, `/detachments/${fx.A._id}`).expect(200);
    const res = await get(fx.scoped.token, `/detachments/${fx.B._id}`).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    await get(fx.main.token, '/detachments/d_unknown').expect(404);
    const other = await f.createTenant();
    const foreign = await f.detachment(other);
    await get(fx.main.token, `/detachments/${foreign._id}`).expect(404);
    await get(fx.main.token, `/detachments/${fx.A._id}?from=bad`).expect(422);
  });
});

describe('GET /tenant/analytics/workshops', () => {
  test('counts, status breakdown, attendance, payments, months', async () => {
    const fx = await build();
    const from = addDays(fx.T, -10);
    const to = addDays(fx.T, 10);
    const { body } = await get(fx.main.token, `/workshops?from=${from}&to=${to}`).expect(200);
    expect(body.range).toEqual({ from, to });
    expect(body).toMatchObject({
      count: 3,
      byStatus: { scheduled: 1, ongoing: 0, done: 2 },
      participants: 5,
      attendancePercent: 67,
      payments: { paid: 2, unpaid: 2, totalCollected: 50000 },
    });
    expect(body.byMonth.reduce((a, m) => a + m.workshops, 0)).toBe(3);
    expect(body.byMonth.reduce((a, m) => a + m.participants, 0)).toBe(5);
    body.byMonth.forEach((m) => expect(m.month).toMatch(/^\d{4}-\d{2}$/));

    // stats.view anywhere suffices (workshops are organisation-level).
    await get(fx.scoped.token, '/workshops').expect(200);
    await get(fx.main.token, `/workshops?from=${to}&to=${from}`).expect(422);
  });
});

describe('GET /tenant/analytics/inventory', () => {
  let fx;
  beforeAll(async () => {
    fx = await build();
  });

  test('levels, expiring list and movements over the scope', async () => {
    const { body } = await get(fx.main.token, '/inventory').expect(200);
    expect(body.items).toBe(3);
    expect(body.byLevel).toEqual({ ok: 1, low: 1, empty: 1 });
    expect(body.expiring).toEqual([
      { itemId: String(fx.item1._id), name: 'شاش معقم', detachmentId: String(fx.A._id), expiresOn: addDays(fx.T, 10), daysLeft: 10 },
    ]);
    expect(body.movements.reduce((a, d) => a + d.inflow, 0)).toBe(10);
    expect(body.movements.reduce((a, d) => a + d.outflow, 0)).toBe(8);
  });

  test('?detachmentId narrows; scoped admin outside its scope → 403; unknown → 404', async () => {
    const { body } = await get(fx.main.token, `/inventory?detachmentId=${fx.B._id}`).expect(200);
    expect(body.items).toBe(1);
    expect(body.byLevel).toEqual({ ok: 0, low: 0, empty: 1 });
    const scoped = await get(fx.scoped.token, '/inventory').expect(200);
    expect(scoped.body.items).toBe(2);
    await get(fx.scoped.token, `/inventory?detachmentId=${fx.B._id}`).expect(403);
    await get(fx.main.token, '/inventory?detachmentId=d_nope').expect(404);
  });
});
