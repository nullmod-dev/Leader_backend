/**
 * Global Search: Arabic folding, types, ranking, visibility, capability and
 * module filtering.
 */
const f = require('./helpers/factory');
const { todayIn, addDays } = require('../utils/time');

const TZ = 'Asia/Damascus';
let tenant;
let main;
let dA;
let dB;
let archived;
const A = () => f.auth(main.token);

const setFeature = (t, key, enabled) => f.models.SaasTenant.updateOne({ _id: t._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled } });
const search = (query, auth = A()) => f.api().get('/api/v1/search').query(query).set(auth);

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  const g = await f.group(tenant);
  dA = await f.detachment(tenant, g, { name: 'مفرزة المزة', region: 'دمشق', mainCenter: 'مركز المزة' });
  dB = await f.detachment(tenant, g, { name: 'مفرزة حلب', region: 'حلب', mainCenter: 'مركز الشهباء' });
  archived = await f.detachment(tenant, g, { name: 'مفرزة مؤرشفة', status: 'archived' });

  await f.member(tenant, dA, { name: 'أحمد السيد', department: 'إسعاف', personalNumber: 'P-100' });
  await f.member(tenant, dB, { name: 'محمد احمدي', department: 'دعم' });
  await f.member(tenant, dA, { name: 'أحمد غير نشط', active: false });
  await f.member(tenant, archived, { name: 'أحمد المؤرشف' });

  const today = todayIn(TZ);
  await f.shift(tenant, dA, { centerName: 'مركز الشعلان' });
  await f.shift(tenant, dA, { centerName: 'مركز الشعلان القديم', date: addDays(today, -40) }); // outside the window

  await f.inventoryItem(tenant, dA, { name: 'شاش معقّم', unit: 'علبة' });
  await f.inventoryItem(tenant, dB, { name: 'قفازات', unit: 'شاش' });
});

describe('GET /search', () => {
  test('Arabic folding (hamza variants) and ranking: exact/prefix title before contains', async () => {
    const res = await search({ q: 'احمد' }).expect(200);
    expect(res.body.query).toBe('احمد');
    const titles = res.body.results.map((r) => r.title);
    expect(titles).toEqual(['أحمد السيد', 'محمد احمدي']); // prefix beats contains; inactive / archived excluded
    expect(res.body.results[0]).toMatchObject({
      type: 'member',
      detachmentId: String(dA._id),
      subtitle: 'إسعاف · مفرزة المزة',
      target: { type: 'member', detachmentId: String(dA._id) },
    });
  });

  test('every type, targets and subtitles', async () => {
    const det = await search({ q: 'المزة' }).expect(200);
    expect(det.body.results.find((r) => r.type === 'detachment')).toMatchObject({
      id: String(dA._id),
      title: 'مفرزة المزة',
      subtitle: 'دمشق · مركز المزة',
      target: { type: 'detachment', detachmentId: String(dA._id) },
    });

    const shift = await search({ q: 'الشعلان' }).expect(200);
    expect(shift.body.results).toHaveLength(1);
    expect(shift.body.results[0]).toMatchObject({ type: 'shift', title: 'مركز الشعلان', target: { type: 'shift', detachmentId: String(dA._id) } });
    expect(shift.body.results[0].subtitle).toMatch(/08:00–14:00 · مفرزة المزة$/);

    const items = await search({ q: 'شاش' }).expect(200);
    expect(items.body.results.map((r) => r.title)).toEqual(['شاش معقّم', 'قفازات']); // title match, then the unit match
    expect(items.body.results[0]).toMatchObject({ type: 'item', target: { type: 'storage', detachmentId: String(dA._id) } });
    expect(items.body.results[0].subtitle).toBe('10 علبة · مفرزة المزة');

    const num = await search({ q: 'p-100' }).expect(200);
    expect(num.body.results.map((r) => r.title)).toEqual(['أحمد السيد']);
  });

  test('types filter and limit', async () => {
    const onlyDet = await search({ q: 'مفرزة', types: 'detachment' }).expect(200);
    expect(onlyDet.body.results.every((r) => r.type === 'detachment')).toBe(true);
    expect(onlyDet.body.results.map((r) => r.title).sort()).toEqual(['مفرزة المزة', 'مفرزة حلب'].sort());
    const one = await search({ q: 'مفرزة', limit: 1 }).expect(200);
    expect(one.body.results).toHaveLength(1);
  });

  test('scoped admin: visible detachments only; members need member.view', async () => {
    const shiftOnly = await f.simpleAdmin(tenant, { global: [], scoped: { [dA._id]: ['shift.manage'] } });
    const res = await search({ q: 'احمد' }, f.auth(shiftOnly.token)).expect(200);
    expect(res.body.results).toEqual([]);
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [dB._id]: ['member.view'] } });
    const res2 = await search({ q: 'احمد' }, f.auth(viewer.token)).expect(200);
    expect(res2.body.results.map((r) => r.title)).toEqual(['محمد احمدي']);
    const items = await search({ q: 'شاش' }, f.auth(viewer.token)).expect(200);
    expect(items.body.results.map((r) => r.title)).toEqual(['قفازات']);
  });

  test('inventory module off → no item results', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const d = await f.detachment(t2);
    await f.inventoryItem(t2, d, { name: 'شاش' });
    expect((await search({ q: 'شاش' }, f.auth(m2.token)).expect(200)).body.results).toHaveLength(1);
    await setFeature(t2, 'inventory', false);
    expect((await search({ q: 'شاش' }, f.auth(m2.token)).expect(200)).body.results).toHaveLength(0);
  });

  test('validation: q required 1..80; unknown type; limit 1..50', async () => {
    await search({}).expect(422);
    await search({ q: '' }).expect(422);
    await search({ q: 'x'.repeat(81) }).expect(422);
    await search({ q: 'ـــ' }).expect(422); // only tatweel → nothing searchable
    const bad = await search({ q: 'a', types: 'member,workshop' }).expect(422);
    expect(bad.body.error.fields.types).toBeDefined();
    await search({ q: 'a', limit: 51 }).expect(422);
  });

  test('super_admin → 403 tenant_context_unavailable', async () => {
    const sa = await f.superAdmin();
    const res = await search({ q: 'x' }, f.auth(sa.token)).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
  });
});
