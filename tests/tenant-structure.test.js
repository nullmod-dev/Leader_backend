/**
 * Detachment groups + detachments: CRUD, visibility, roll-ups, stats, images,
 * cascade delete, plan limits, feature gates, optimistic concurrency.
 */
const sharp = require('sharp');
const f = require('./helpers/factory');
const { todayIn, addDays } = require('../utils/time');

const { DetachmentGroup, Detachment, TeamMember, Shift, ShiftTemplate, InventoryItem, InventoryMovement, Announcement, Account, ChangeLog, StoredFile } =
  f.models;

let tenant;
let main;
let png;
const A = () => f.auth(main.token);
const tid = () => String(tenant._id);

const setLimit = (t, key, value) => f.models.SaasTenant.updateOne({ _id: t._id }, { $set: { [`subscription.limitOverrides.${key}`]: value } });
const setFeature = (t, key, enabled) => f.models.SaasTenant.updateOne({ _id: t._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled } });

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  // This suite creates many records in one tenant; limits are exercised on fresh tenants below.
  await setLimit(tenant, 'detachment_groups', 1000);
  await setLimit(tenant, 'detachments', 1000);
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a7' } }).png().toBuffer();
});

describe('surface', () => {
  test('super_admin token on a tenant route → 403 tenant_context_unavailable', async () => {
    const sa = await f.superAdmin();
    const res = await f.api().get('/api/v1/detachment-groups').set(f.auth(sa.token)).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
    const res2 = await f.api().get('/api/v1/detachments').set(f.auth(sa.token)).expect(403);
    expect(res2.body.error.code).toBe('tenant_context_unavailable');
  });

  test('no bearer → 401 authentication_expired', async () => {
    const res = await f.api().get('/api/v1/detachments').expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });
});

describe('detachment groups', () => {
  test('create → 201 with zero roll-ups; list; get', async () => {
    const res = await f.api().post('/api/v1/detachment-groups').set(A()).set(f.idem()).send({ name: '  فرق   دمشق  ', notes: 'ملاحظة' }).expect(201);
    expect(res.body).toMatchObject({ name: 'فرق دمشق', notes: 'ملاحظة', status: 'active', version: 1, detachmentCount: 0, memberCount: 0, coveragePercent: 0 });
    expect(res.body.id).toMatch(/^g_/);
    expect(res.body.createdAt).toMatch(/Z$/);

    const list = await f.api().get('/api/v1/detachment-groups').set(A()).expect(200);
    expect(list.body.map((g) => g.id)).toContain(res.body.id);

    const got = await f.api().get(`/api/v1/detachment-groups/${res.body.id}`).set(A()).expect(200);
    expect(got.body.name).toBe('فرق دمشق');
  });

  test('query matches name/notes with Arabic folding', async () => {
    await f.group(tenant, { name: 'مجموعة الساحل', notes: 'اللاذقية وطرطوس' });
    const byName = await f.api().get('/api/v1/detachment-groups').query({ query: 'الساحل' }).set(A()).expect(200);
    expect(byName.body.map((g) => g.name)).toEqual(['مجموعة الساحل']);
    const byNotes = await f.api().get('/api/v1/detachment-groups').query({ query: 'اللاذقيه' }).set(A()).expect(200);
    expect(byNotes.body.map((g) => g.name)).toEqual(['مجموعة الساحل']);
  });

  test('validation: empty name → 422', async () => {
    const res = await f.api().post('/api/v1/detachment-groups').set(A()).send({ name: '   ' }).expect(422);
    expect(res.body.error.code).toBe('validation');
    expect(res.body.error.fields.name).toBeDefined();
  });

  test('duplicate name (normalized) → 409 conflict', async () => {
    await f.group(tenant, { name: 'مجموعة مكررة' });
    const res = await f.api().post('/api/v1/detachment-groups').set(A()).send({ name: 'مجموعة  مكررة' }).expect(409);
    expect(res.body.error.code).toBe('conflict');
  });

  test('capability: a simple admin without detachment.create → 403 not_permitted', async () => {
    const det = await f.detachment(tenant);
    const simple = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    const res = await f.api().post('/api/v1/detachment-groups').set(f.auth(simple.token)).send({ name: 'غير مسموح' }).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    const put = await f.api().put(`/api/v1/detachment-groups/${det.detachmentGroupId}`).set(f.auth(simple.token)).send({ name: 'x' }).expect(403);
    expect(put.body.error.code).toBe('not_permitted');
    const del = await f.api().delete(`/api/v1/detachment-groups/${det.detachmentGroupId}`).set(f.auth(simple.token)).expect(403);
    expect(del.body.error.code).toBe('not_permitted');
  });

  test('unknown group → 404 not_found', async () => {
    const res = await f.api().get('/api/v1/detachment-groups/g_nope').set(A()).expect(404);
    expect(res.body.error.code).toBe('not_found');
    await f.api().put('/api/v1/detachment-groups/g_nope').set(A()).send({ name: 'x' }).expect(404);
  });

  test('PUT ignores roll-up fields, clears absent notes; PATCH is partial; body id must match', async () => {
    const g = await f.group(tenant, { name: 'قبل التعديل', notes: 'تبقى؟' });
    const put = await f.api()
      .put(`/api/v1/detachment-groups/${g._id}`)
      .set(A())
      .send({ id: String(g._id), name: 'بعد التعديل', memberCount: 999, coveragePercent: 77, detachmentCount: 5 })
      .expect(200);
    expect(put.body).toMatchObject({ name: 'بعد التعديل', memberCount: 0, coveragePercent: 0, detachmentCount: 0, version: 2 });
    expect(put.body.notes).toBeUndefined();

    const patch = await f.api().patch(`/api/v1/detachment-groups/${g._id}`).set(A()).send({ notes: 'ملاحظة جديدة' }).expect(200);
    expect(patch.body).toMatchObject({ name: 'بعد التعديل', notes: 'ملاحظة جديدة', version: 3 });

    const mismatch = await f.api().put(`/api/v1/detachment-groups/${g._id}`).set(A()).send({ id: 'g_other', name: 'x' }).expect(422);
    expect(mismatch.body.error.fields.id).toBeDefined();
  });

  test('rename onto another group name → 409 conflict', async () => {
    const a = await f.group(tenant, { name: 'الاسم الأول' });
    await f.group(tenant, { name: 'الاسم الثاني' });
    const res = await f.api().patch(`/api/v1/detachment-groups/${a._id}`).set(A()).send({ name: 'الاسم الثاني' }).expect(409);
    expect(res.body.error.code).toBe('conflict');
  });

  test('stale version → 409 stale_write with currentRecord', async () => {
    const g = await f.group(tenant);
    await f.api().patch(`/api/v1/detachment-groups/${g._id}`).set(A()).send({ notes: 'أولى', version: 1 }).expect(200);
    const res = await f.api().patch(`/api/v1/detachment-groups/${g._id}`).set(A()).send({ notes: 'ثانية', version: 1 }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'stale_write', currentVersion: 2 });
    expect(res.body.error.currentRecord).toMatchObject({ id: String(g._id), notes: 'أولى', version: 2 });
  });

  test('plan limit detachment_groups → 409 plan_limit_reached', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    await f.group(t2);
    await setLimit(t2, 'detachment_groups', 1);
    const res = await f.api().post('/api/v1/detachment-groups').set(f.auth(m2.token)).send({ name: 'فوق الحد' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'plan_limit_reached', limitKey: 'detachment_groups', limit: 1, usage: 1 });
  });

  test('idempotent create replays the original response', async () => {
    const key = f.idem();
    const a = await f.api().post('/api/v1/detachment-groups').set(A()).set(key).send({ name: 'مجموعة متكررة الطلب' }).expect(201);
    const b = await f.api().post('/api/v1/detachment-groups').set(A()).set(key).send({ name: 'مجموعة متكررة الطلب' }).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('visibility (scoped admin)', () => {
  let gVisible;
  let gHidden;
  let dVisible;
  let dHidden;
  let simple;

  beforeAll(async () => {
    gVisible = await f.group(tenant, { name: 'مرئية' });
    gHidden = await f.group(tenant, { name: 'مخفية' });
    dVisible = await f.detachment(tenant, gVisible, { name: 'مفرزة مرئية' });
    dHidden = await f.detachment(tenant, gHidden, { name: 'مفرزة مخفية' });
    simple = await f.simpleAdmin(tenant, { global: [], scoped: { [dVisible._id]: ['member.view'] } });
  });

  test('groups list holds only groups with a visible detachment; hidden group → 404', async () => {
    const res = await f.api().get('/api/v1/detachment-groups').set(f.auth(simple.token)).expect(200);
    expect(res.body.map((g) => g.id)).toEqual([String(gVisible._id)]);
    await f.api().get(`/api/v1/detachment-groups/${gVisible._id}`).set(f.auth(simple.token)).expect(200);
    const hidden = await f.api().get(`/api/v1/detachment-groups/${gHidden._id}`).set(f.auth(simple.token)).expect(404);
    expect(hidden.body.error.code).toBe('not_found');
  });

  test('detachments list holds only visible ones; hidden detachment → 403', async () => {
    const res = await f.api().get('/api/v1/detachments').set(f.auth(simple.token)).expect(200);
    expect(res.body.map((d) => d.id)).toEqual([String(dVisible._id)]);
    await f.api().get(`/api/v1/detachments/${dVisible._id}`).set(f.auth(simple.token)).expect(200);
    const hidden = await f.api().get(`/api/v1/detachments/${dHidden._id}`).set(f.auth(simple.token)).expect(403);
    expect(hidden.body.error.code).toBe('not_permitted');
  });

  test('a detachment of another tenant → 404, never 403', async () => {
    const { tenant: other } = await f.tenantWithMainAdmin();
    const foreign = await f.detachment(other);
    const res = await f.api().get(`/api/v1/detachments/${foreign._id}`).set(A()).expect(404);
    expect(res.body.error.code).toBe('not_found');
    await f.api().get(`/api/v1/detachments/${foreign._id}`).set(f.auth(simple.token)).expect(404);
  });
});

describe('detachments', () => {
  let group;
  beforeAll(async () => {
    group = await f.group(tenant, { name: 'مجموعة المفارز' });
  });

  test('create → 201; unknown group → 422 fields.detachmentGroupId; empty name → 422', async () => {
    const res = await f.api()
      .post('/api/v1/detachments')
      .set(A())
      .send({ detachmentGroupId: String(group._id), name: 'مفرزة المزة', region: 'دمشق', mainCenter: 'مركز المزة', notes: 'جديدة' })
      .expect(201);
    expect(res.body).toMatchObject({
      detachmentGroupId: String(group._id),
      name: 'مفرزة المزة',
      region: 'دمشق',
      mainCenter: 'مركز المزة',
      notes: 'جديدة',
      status: 'active',
      memberCount: 0,
      weeklyShiftCount: 0,
      coveragePercent: 0,
      version: 1,
    });
    const bad = await f.api().post('/api/v1/detachments').set(A()).send({ detachmentGroupId: 'g_missing', name: 'x', region: '', mainCenter: '' }).expect(422);
    expect(bad.body.error.fields.detachmentGroupId).toBeDefined();
    const empty = await f.api().post('/api/v1/detachments').set(A()).send({ detachmentGroupId: String(group._id), name: '' }).expect(422);
    expect(empty.body.error.fields.name).toBeDefined();
  });

  test('capability: create needs global detachment.create', async () => {
    const det = await f.detachment(tenant, group);
    const simple = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['detachment.edit'] } });
    const res = await f.api().post('/api/v1/detachments').set(f.auth(simple.token)).send({ detachmentGroupId: String(group._id), name: 'x' }).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });

  test('list filters: group, active/archived, query', async () => {
    const g = await f.group(tenant, { name: 'مجموعة الفلترة' });
    const a = await f.detachment(tenant, g, { name: 'مفرزة حمص', region: 'حمص' });
    const b = await f.detachment(tenant, g, { name: 'مفرزة حماة', status: 'archived' });
    const all = await f.api().get('/api/v1/detachments').query({ detachmentGroupId: String(g._id) }).set(A()).expect(200);
    expect(all.body.map((d) => d.id).sort()).toEqual([String(a._id), String(b._id)].sort());
    const active = await f.api().get('/api/v1/detachments').query({ detachmentGroupId: String(g._id), filter: 'active' }).set(A()).expect(200);
    expect(active.body.map((d) => d.id)).toEqual([String(a._id)]);
    const archived = await f.api().get('/api/v1/detachments').query({ detachmentGroupId: String(g._id), filter: 'archived' }).set(A()).expect(200);
    expect(archived.body.map((d) => d.id)).toEqual([String(b._id)]);
    const q = await f.api().get('/api/v1/detachments').query({ detachmentGroupId: String(g._id), query: 'حمص' }).set(A()).expect(200);
    expect(q.body.map((d) => d.id)).toEqual([String(a._id)]);
    await f.api().get('/api/v1/detachments').query({ filter: 'bogus' }).set(A()).expect(422);
  });

  test('PUT full JSON; status change needs detachment.archive; moving needs an existing group', async () => {
    const det = await f.detachment(tenant, group, { notes: 'ستمحى' });
    const other = await f.group(tenant);
    const res = await f.api()
      .put(`/api/v1/detachments/${det._id}`)
      .set(A())
      .send({ id: String(det._id), detachmentGroupId: String(other._id), name: 'اسم جديد', region: 'ريف دمشق', mainCenter: 'مركز', status: 'active', memberCount: 50 })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'اسم جديد', region: 'ريف دمشق', detachmentGroupId: String(other._id), memberCount: 0, version: 2 });
    expect(res.body.notes).toBeUndefined();

    const moveBad = await f.api().patch(`/api/v1/detachments/${det._id}`).set(A()).send({ detachmentGroupId: 'g_missing' }).expect(422);
    expect(moveBad.body.error.fields.detachmentGroupId).toBeDefined();

    const editor = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['detachment.edit'] } });
    const noArchive = await f.api().patch(`/api/v1/detachments/${det._id}`).set(f.auth(editor.token)).send({ status: 'archived' }).expect(403);
    expect(noArchive.body.error.code).toBe('not_permitted');
    const ok = await f.api().patch(`/api/v1/detachments/${det._id}`).set(f.auth(editor.token)).send({ mainCenter: 'مركز آخر' }).expect(200);
    expect(ok.body.mainCenter).toBe('مركز آخر');

    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    await f.api().patch(`/api/v1/detachments/${det._id}`).set(f.auth(viewer.token)).send({ name: 'x' }).expect(403);
  });

  test('stale version on PUT → 409 stale_write', async () => {
    const det = await f.detachment(tenant, group);
    await f.api().patch(`/api/v1/detachments/${det._id}`).set(A()).send({ region: 'أ', version: 1 }).expect(200);
    const res = await f.api().patch(`/api/v1/detachments/${det._id}`).set(A()).send({ region: 'ب', version: 1 }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'stale_write', currentVersion: 2 });
    expect(res.body.error.currentRecord).toMatchObject({ id: String(det._id), region: 'أ' });
  });

  test('archive / restore; restore checks the detachments limit', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const det = await f.detachment(t2);
    const arch = await f.api().post(`/api/v1/detachments/${det._id}/archive`).set(f.auth(m2.token)).expect(200);
    expect(arch.body.status).toBe('archived');
    await f.detachment(t2); // one active detachment now
    await setLimit(t2, 'detachments', 1);
    const limited = await f.api().post(`/api/v1/detachments/${det._id}/restore`).set(f.auth(m2.token)).expect(409);
    expect(limited.body.error).toMatchObject({ code: 'plan_limit_reached', limitKey: 'detachments' });
    await setLimit(t2, 'detachments', 5);
    const restored = await f.api().post(`/api/v1/detachments/${det._id}/restore`).set(f.auth(m2.token)).expect(200);
    expect(restored.body.status).toBe('active');
  });

  test('create is refused at the detachments limit', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const g = await f.group(t2);
    await f.detachment(t2, g);
    await setLimit(t2, 'detachments', 1);
    const res = await f.api().post('/api/v1/detachments').set(f.auth(m2.token)).send({ detachmentGroupId: String(g._id), name: 'زائدة' }).expect(409);
    expect(res.body.error.code).toBe('plan_limit_reached');
  });
});

describe('roll-ups', () => {
  test('detachment memberCount / weeklyShiftCount / coveragePercent; group means over ACTIVE detachments only', async () => {
    const g = await f.group(tenant, { name: 'مجموعة الحساب' });
    const full = await f.detachment(tenant, g);
    const empty = await f.detachment(tenant, g);
    const archived = await f.detachment(tenant, g, { status: 'archived' });

    const m1 = await f.member(tenant, full);
    const m2 = await f.member(tenant, full);
    await f.member(tenant, full, { active: false });
    const e1 = await f.member(tenant, empty);
    const a1 = await f.member(tenant, archived);

    // full: 2 shifts, needed 2 each, 2 + 3(capped at 2) assigned → 100
    await f.shift(tenant, full, { needed: 2, attendees: [{ memberId: m1._id }, { memberId: m2._id }] });
    await f.shift(tenant, full, { needed: 2, startMinutes: 900, endMinutes: 1200, attendees: [{ memberId: m1._id }, { memberId: m2._id }, { memberId: 'm_ghost' }] });
    // empty: needed 4, 1 assigned → 25
    await f.shift(tenant, empty, { needed: 4, attendees: [{ memberId: e1._id }] });
    // archived: 100% but excluded from the group mean
    await f.shift(tenant, archived, { needed: 1, attendees: [{ memberId: a1._id }] });

    const dets = await f.api().get('/api/v1/detachments').query({ detachmentGroupId: String(g._id) }).set(A()).expect(200);
    const byId = new Map(dets.body.map((d) => [d.id, d]));
    expect(byId.get(String(full._id))).toMatchObject({ memberCount: 2, weeklyShiftCount: 2, coveragePercent: 100 });
    expect(byId.get(String(empty._id))).toMatchObject({ memberCount: 1, weeklyShiftCount: 1, coveragePercent: 25 });
    expect(byId.get(String(archived._id))).toMatchObject({ memberCount: 1, weeklyShiftCount: 1, coveragePercent: 100 });

    const grp = await f.api().get(`/api/v1/detachment-groups/${g._id}`).set(A()).expect(200);
    // mean of 100 and 25 (archived excluded) = 62.5 → 63; members include the archived detachment
    expect(grp.body).toMatchObject({ detachmentCount: 3, memberCount: 4, coveragePercent: 63 });
  });
});

describe('stats', () => {
  test('series: one value per day, oldest first, ending today, with definitions', async () => {
    const det = await f.detachment(tenant);
    const tz = tenant.timezone || 'Asia/Damascus';
    const today = todayIn(tz);
    const yesterday = addDays(today, -1);
    const m = await f.member(tenant, det);
    await f.shift(tenant, det, {
      date: today,
      needed: 4,
      attendees: [
        { memberId: m._id, attendance: 'checkedIn' },
        { memberId: 'm_x2', attendance: 'checkedOut' },
        { memberId: 'm_x3', attendance: 'absent' },
        { memberId: 'm_x4', attendance: 'notCheckedIn' },
      ],
    });
    await f.shift(tenant, det, { date: yesterday, needed: 2, attendees: [{ memberId: m._id, attendance: 'absent' }] });
    const item = await f.inventoryItem(tenant, det);
    await InventoryMovement.create([
      { tenantId: tid(), detachmentId: String(det._id), itemId: String(item._id), direction: 'inflow', quantity: 1, convertedBaseUnitQuantity: 1, at: new Date() },
      { tenantId: tid(), detachmentId: String(det._id), itemId: String(item._id), direction: 'outflow', quantity: 1, convertedBaseUnitQuantity: 1, at: new Date() },
    ]);

    const res = await f.api().get(`/api/v1/detachments/${det._id}/stats`).set(A()).expect(200);
    const s = res.body;
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toBe(today);
    expect(s.from).toBe(s.days[0]);
    expect(s.to).toBe(today);
    expect(s.attendanceSeries).toHaveLength(7);
    expect(s.attendanceSeries[6]).toBe(67); // 2 resolved of 3 answered
    expect(s.attendanceSeries[5]).toBe(0); // 0 of 1
    expect(s.coverageSeries[6]).toBe(100); // min(4,4)/4
    expect(s.coverageSeries[5]).toBe(50);
    expect(s.coverageSeries[0]).toBe(0);
    expect(s.stockSeries[6]).toBe(2);
    expect(Object.keys(s.definitions).sort()).toEqual(['attendanceSeries', 'coverageSeries', 'stockSeries']);

    const long = await f.api().get(`/api/v1/detachments/${det._id}/stats`).query({ days: 30 }).set(A()).expect(200);
    expect(long.body.stockSeries).toHaveLength(30);
    await f.api().get(`/api/v1/detachments/${det._id}/stats`).query({ days: 3 }).set(A()).expect(422);
  });

  test('stats.view required; feature statistics_reports required', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const det = await f.detachment(t2);
    const simple = await f.simpleAdmin(t2, { global: [], scoped: { [det._id]: ['member.view'] } });
    const denied = await f.api().get(`/api/v1/detachments/${det._id}/stats`).set(f.auth(simple.token)).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
    await setFeature(t2, 'statistics_reports', false);
    const off = await f.api().get(`/api/v1/detachments/${det._id}/stats`).set(f.auth(m2.token)).expect(403);
    expect(off.body.error.code).toBe('feature_disabled');
  });
});

describe('detachment image', () => {
  test('upload → imageUrl; replace removes the old file; delete clears it', async () => {
    const det = await f.detachment(tenant);
    const up = await f.api().post(`/api/v1/detachments/${det._id}/image`).set(A()).attach('image', png, 'd.png').expect(200);
    expect(up.body.imageUrl).toMatch(/^http:\/\/localhost:4000\/images\/detachments\/detachment-.*\.webp$/);
    const first = (await Detachment.findById(det._id)).imagePath;
    const again = await f.api().post(`/api/v1/detachments/${det._id}/image`).set(A()).attach('image', png, 'd.png').expect(200);
    expect(again.body.imageUrl).not.toBe(up.body.imageUrl);
    expect(await StoredFile.countDocuments({ path: first })).toBe(0);
    const del = await f.api().delete(`/api/v1/detachments/${det._id}/image`).set(A()).expect(200);
    expect(del.body.imageUrl).toBeUndefined();
    expect(await StoredFile.countDocuments({ ownerType: 'detachment', ownerId: String(det._id) })).toBe(0);
  });

  test('missing file → 422; not an image → 422; no detachment.edit → 403', async () => {
    const det = await f.detachment(tenant);
    const none = await f.api().post(`/api/v1/detachments/${det._id}/image`).set(A()).expect(422);
    expect(none.body.error.fields.image).toBeDefined();
    const junk = await f.api().post(`/api/v1/detachments/${det._id}/image`).set(A()).attach('image', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' }).expect(422);
    expect(junk.body.error.code).toBe('validation');
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    await f.api().post(`/api/v1/detachments/${det._id}/image`).set(f.auth(viewer.token)).attach('image', png, 'd.png').expect(403);
  });
});

describe('detachment sub-resources', () => {
  test('members: role order then name; inactive only on request; phoneMasked needs member.contact.view', async () => {
    const det = await f.detachment(tenant);
    await f.member(tenant, det, { name: 'ياسر', role: 'member' });
    await f.member(tenant, det, { name: 'باسل', role: 'followUp' });
    await f.member(tenant, det, { name: 'أحمد', role: 'shiftSupervisor' });
    await f.member(tenant, det, { name: 'زياد', role: 'administrator' });
    await f.member(tenant, det, { name: 'بشير', role: 'member' });
    await f.member(tenant, det, { name: 'غائب', role: 'member', active: false });

    const res = await f.api().get(`/api/v1/detachments/${det._id}/members`).set(A()).expect(200);
    expect(res.body.map((m) => m.name)).toEqual(['أحمد', 'زياد', 'باسل', 'بشير', 'ياسر']);
    expect(res.body[0].phoneMasked).toMatch(/^\+963 /);
    const all = await f.api().get(`/api/v1/detachments/${det._id}/members`).query({ includeInactive: true }).set(A()).expect(200);
    expect(all.body).toHaveLength(6);

    const noContact = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    const masked = await f.api().get(`/api/v1/detachments/${det._id}/members`).set(f.auth(noContact.token)).expect(200);
    expect(masked.body.every((m) => m.phoneMasked === undefined)).toBe(true);
    const contact = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view', 'member.contact.view'] } });
    const shown = await f.api().get(`/api/v1/detachments/${det._id}/members`).set(f.auth(contact.token)).expect(200);
    expect(shown.body.every((m) => typeof m.phoneMasked === 'string')).toBe(true);

    const noView = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.manage'] } });
    await f.api().get(`/api/v1/detachments/${det._id}/members`).set(f.auth(noView.token)).expect(403);
  });

  test('inventory items sorted by name; movements newest first; feature gate', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const det = await f.detachment(t2);
    const b = await f.inventoryItem(t2, det, { name: 'ضمادات' });
    await f.inventoryItem(t2, det, { name: 'أربطة' });
    const older = new Date(Date.now() - 60000);
    await InventoryMovement.create([
      { tenantId: String(t2._id), detachmentId: String(det._id), itemId: String(b._id), direction: 'inflow', quantity: 1, convertedBaseUnitQuantity: 1, at: older },
      { tenantId: String(t2._id), detachmentId: String(det._id), itemId: String(b._id), direction: 'outflow', quantity: 2, convertedBaseUnitQuantity: 2, at: new Date() },
    ]);
    const items = await f.api().get(`/api/v1/detachments/${det._id}/inventory-items`).set(f.auth(m2.token)).expect(200);
    expect(items.body.map((i) => i.name)).toEqual(['أربطة', 'ضمادات']);
    const mv = await f.api().get(`/api/v1/detachments/${det._id}/inventory-movements`).query({ limit: 1 }).set(f.auth(m2.token)).expect(200);
    expect(mv.body).toHaveLength(1);
    expect(mv.body[0].direction).toBe('outflow');
    await f.api().get(`/api/v1/detachments/${det._id}/inventory-movements`).query({ limit: 500 }).set(f.auth(m2.token)).expect(422);

    await setFeature(t2, 'inventory', false);
    const off = await f.api().get(`/api/v1/detachments/${det._id}/inventory-items`).set(f.auth(m2.token)).expect(403);
    expect(off.body.error.code).toBe('feature_disabled');
  });
});

describe('cascade delete', () => {
  const seedDetachment = async (grp) => {
    const det = await f.detachment(tenant, grp);
    const m = await f.member(tenant, det);
    await f.shift(tenant, det, { attendees: [{ memberId: m._id }] });
    await ShiftTemplate.create({ tenantId: tid(), detachmentId: String(det._id), centerName: 'قالب', dates: [todayIn('Asia/Damascus')], startMinutes: 480, endMinutes: 840, needed: 2 });
    const item = await f.inventoryItem(tenant, det);
    await InventoryMovement.create({ tenantId: tid(), detachmentId: String(det._id), itemId: String(item._id), direction: 'inflow', quantity: 3, convertedBaseUnitQuantity: 3 });
    return { det, m, item };
  };

  test('DELETE /detachments/:id removes everything inside it, pulls announcements and grants', async () => {
    const grp = await f.group(tenant);
    const { det, m } = await seedDetachment(grp);
    const keep = await f.detachment(tenant, grp);
    // member photo
    await f.api().post(`/api/v1/members/${m._id}/photo`).set(A()).attach('image', png, 'm.png').expect(200);
    await f.api().post(`/api/v1/detachments/${det._id}/image`).set(A()).attach('image', png, 'd.png').expect(200);

    const now = new Date();
    const only = await Announcement.create({ tenantId: tid(), text: 'إعلان للمفرزة فقط', detachmentIds: [String(det._id)], publishedAt: now, expiresAt: new Date(now.getTime() + 86400000) });
    const shared = await Announcement.create({ tenantId: tid(), text: 'إعلان مشترك بين مفرزتين', detachmentIds: [String(det._id), String(keep._id)], publishedAt: now, expiresAt: new Date(now.getTime() + 86400000) });
    const scoped = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'], [keep._id]: ['member.view'] } });

    await f.api().delete(`/api/v1/detachments/${det._id}`).set(A()).expect(204);

    const scope = { tenantId: tid(), detachmentId: String(det._id) };
    expect(await Detachment.countDocuments({ _id: det._id })).toBe(0);
    expect(await TeamMember.countDocuments(scope)).toBe(0);
    expect(await Shift.countDocuments(scope)).toBe(0);
    expect(await ShiftTemplate.countDocuments(scope)).toBe(0);
    expect(await InventoryItem.countDocuments(scope)).toBe(0);
    expect(await InventoryMovement.countDocuments(scope)).toBe(0);
    expect(await Announcement.countDocuments({ _id: only._id })).toBe(0);
    expect((await Announcement.findById(shared._id)).detachmentIds).toEqual([String(keep._id)]);
    const acc = await Account.findById(scoped.account._id);
    expect([...acc.capabilities.scoped.keys()]).toEqual([String(keep._id)]);
    expect(await StoredFile.countDocuments({ ownerType: 'member', ownerId: String(m._id) })).toBe(0);
    expect(await StoredFile.countDocuments({ ownerType: 'detachment', ownerId: String(det._id) })).toBe(0);
    expect(await Detachment.countDocuments({ _id: keep._id })).toBe(1);

    const deletes = await ChangeLog.find({ tenantId: tid(), op: 'delete', entityId: { $in: [String(det._id), String(m._id)] } });
    expect(deletes.map((c) => c.entityType).sort()).toEqual(['detachment', 'team_member']);
  });

  test('archive capability required to delete', async () => {
    const det = await f.detachment(tenant);
    const editor = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['detachment.edit'] } });
    const res = await f.api().delete(`/api/v1/detachments/${det._id}`).set(f.auth(editor.token)).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    const archiver = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['detachment.archive'] } });
    await f.api().delete(`/api/v1/detachments/${det._id}`).set(f.auth(archiver.token)).expect(204);
  });

  test('DELETE /detachment-groups/:id cascades through every detachment (archived included)', async () => {
    const grp = await f.group(tenant, { name: 'ستحذف' });
    const a = await seedDetachment(grp);
    const b = await seedDetachment(grp);
    await Detachment.updateOne({ _id: b.det._id }, { $set: { status: 'archived' } });
    const other = await f.detachment(tenant);

    await f.api().delete(`/api/v1/detachment-groups/${grp._id}`).set(A()).expect(204);

    expect(await DetachmentGroup.countDocuments({ _id: grp._id })).toBe(0);
    const ids = [String(a.det._id), String(b.det._id)];
    expect(await Detachment.countDocuments({ _id: { $in: ids } })).toBe(0);
    expect(await TeamMember.countDocuments({ detachmentId: { $in: ids } })).toBe(0);
    expect(await Shift.countDocuments({ detachmentId: { $in: ids } })).toBe(0);
    expect(await InventoryItem.countDocuments({ detachmentId: { $in: ids } })).toBe(0);
    expect(await InventoryMovement.countDocuments({ detachmentId: { $in: ids } })).toBe(0);
    expect(await Detachment.countDocuments({ _id: other._id })).toBe(1);
    await f.api().get(`/api/v1/detachment-groups/${grp._id}`).set(A()).expect(404);
  });
});
