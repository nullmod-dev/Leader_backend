/**
 * Team members: create / quick-create / match / edit / role / roster
 * attendance / lifecycle / delete / photo, with the business codes
 * name_taken, number_taken and plan_limit_reached.
 */
const sharp = require('sharp');
const f = require('./helpers/factory');

const { TeamMember, StoredFile, ChangeLog } = f.models;

let tenant;
let main;
let det;
let png;
const A = () => f.auth(main.token);

const setLimit = (t, key, value) => f.models.SaasTenant.updateOne({ _id: t._id }, { $set: { [`subscription.limitOverrides.${key}`]: value } });

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  det = await f.detachment(tenant);
  png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#a53' } }).png().toBuffer();
});

describe('POST /members', () => {
  test('201 with normalized name, legacy role mapped, masked phone, never the raw phone', async () => {
    const res = await f.api()
      .post('/api/v1/members')
      .set(A())
      .set(f.idem())
      .send({ detachmentId: String(det._id), name: '  خالد   العمر ', department: 'إسعاف', personalNumber: '١٢٣', role: 'medic', phone: '+963 944 555 666' })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'خالد العمر',
      initials: 'خا',
      department: 'إسعاف',
      personalNumber: '123',
      role: 'administrator',
      detachmentId: String(det._id),
      attendance: 'notCheckedIn',
      active: true,
      version: 1,
    });
    expect(res.body.id).toMatch(/^m_/);
    expect(res.body.phoneMasked).toBe('+963 9xx xxx 666');
    expect(res.body.phone).toBeUndefined();
    const stored = await TeamMember.findById(res.body.id);
    expect(stored.phone).toBe('+963944555666');
  });

  test('duplicate normalized name → 409 name_taken; duplicate personal number → 409 number_taken', async () => {
    await f.member(tenant, det, { name: 'سامر الحسن', personalNumber: 'P-7' });
    const name = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(det._id), name: 'سامر  الحسن' }).expect(409);
    expect(name.body.error.code).toBe('name_taken');
    const num = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(det._id), name: 'اسم آخر', personalNumber: 'P-7' }).expect(409);
    expect(num.body.error.code).toBe('number_taken');
    // same name in ANOTHER detachment is fine
    const other = await f.detachment(tenant);
    await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(other._id), name: 'سامر الحسن' }).expect(201);
  });

  test('validation: empty name, unknown role → 422', async () => {
    const empty = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(det._id), name: ' ' }).expect(422);
    expect(empty.body.error.fields.name).toBeDefined();
    const role = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(det._id), name: 'دور مجهول', role: 'captain' }).expect(422);
    expect(role.body.error.fields.role).toBeDefined();
    const phone = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: String(det._id), name: 'هاتف خاطئ', phone: 'abc' }).expect(422);
    expect(phone.body.error.fields.phone).toBeDefined();
  });

  test('unknown detachment → 404; no member.invite there → 403', async () => {
    const missing = await f.api().post('/api/v1/members').set(A()).send({ detachmentId: 'd_missing', name: 'أحد' }).expect(404);
    expect(missing.body.error.code).toBe('not_found');
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    const denied = await f.api().post('/api/v1/members').set(f.auth(viewer.token)).send({ detachmentId: String(det._id), name: 'أحد' }).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
  });

  test('plan limit members → 409 plan_limit_reached', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const d2 = await f.detachment(t2);
    await setLimit(t2, 'members', 1);
    await f.api().post('/api/v1/members').set(f.auth(m2.token)).send({ detachmentId: String(d2._id), name: 'الأول' }).expect(201);
    const res = await f.api().post('/api/v1/members').set(f.auth(m2.token)).send({ detachmentId: String(d2._id), name: 'الثاني' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'plan_limit_reached', limitKey: 'members', limit: 1, usage: 1 });
  });
});

describe('POST /members/from-shift + GET /members/match', () => {
  test('quick member gets shift-<n>, role member; name collision → name_taken', async () => {
    const d = await f.detachment(tenant);
    const a = await f.api().post('/api/v1/members/from-shift').set(A()).send({ detachmentId: String(d._id), name: 'متطوع سريع' }).expect(201);
    const b = await f.api().post('/api/v1/members/from-shift').set(A()).send({ detachmentId: String(d._id), name: 'متطوع سريع ثان' }).expect(201);
    expect(a.body).toMatchObject({ role: 'member', personalNumber: 'shift-1' });
    expect(b.body.personalNumber).toBe('shift-2');
    const dup = await f.api().post('/api/v1/members/from-shift').set(A()).send({ detachmentId: String(d._id), name: 'متطوع  سريع' }).expect(409);
    expect(dup.body.error.code).toBe('name_taken');
  });

  test('match by normalized name', async () => {
    const d = await f.detachment(tenant);
    const m = await f.member(tenant, d, { name: 'ليلى سعيد' });
    const hit = await f.api().get('/api/v1/members/match').query({ detachmentId: String(d._id), name: '  ليلى   سعيد ' }).set(A()).expect(200);
    expect(hit.body.match.id).toBe(String(m._id));
    const miss = await f.api().get('/api/v1/members/match').query({ detachmentId: String(d._id), name: 'غير موجود' }).set(A()).expect(200);
    expect(miss.body).toEqual({ match: null });
    await f.api().get('/api/v1/members/match').query({ detachmentId: String(d._id) }).set(A()).expect(422);
    const other = await f.simpleAdmin(tenant, { global: [], scoped: { d_elsewhere: ['member.view'] } });
    await f.api().get('/api/v1/members/match').query({ detachmentId: String(d._id), name: 'ليلى سعيد' }).set(f.auth(other.token)).expect(403);
  });
});

describe('GET / PUT / PATCH /members/:id', () => {
  test('get; 404 in another tenant; 403 without member.view', async () => {
    const m = await f.member(tenant, det);
    const res = await f.api().get(`/api/v1/members/${m._id}`).set(A()).expect(200);
    expect(res.body.id).toBe(String(m._id));
    const { tenant: other } = await f.tenantWithMainAdmin();
    const foreign = await f.member(other, await f.detachment(other));
    await f.api().get(`/api/v1/members/${foreign._id}`).set(A()).expect(404);
    const noView = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['shift.manage'] } });
    await f.api().get(`/api/v1/members/${m._id}`).set(f.auth(noView.token)).expect(403);
  });

  test('PUT replaces the form fields, keeps the phone when absent; name_taken / number_taken exclude itself', async () => {
    const m = await f.member(tenant, det, { name: 'قديم', personalNumber: 'N1', department: 'قسم' });
    await f.member(tenant, det, { name: 'محجوز', personalNumber: 'N2' });
    const res = await f.api()
      .put(`/api/v1/members/${m._id}`)
      .set(A())
      .send({ id: String(m._id), name: 'قديم', personalNumber: 'N1', department: '', phoneMasked: '+963 9xx xxx 123', attendance: 'absent' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'قديم', department: '', personalNumber: 'N1', attendance: 'notCheckedIn', version: 2 });
    expect((await TeamMember.findById(m._id)).phone).toBe('+963912345123');

    const taken = await f.api().put(`/api/v1/members/${m._id}`).set(A()).send({ name: 'محجوز', department: '', personalNumber: 'N1' }).expect(409);
    expect(taken.body.error.code).toBe('name_taken');
    const num = await f.api().patch(`/api/v1/members/${m._id}`).set(A()).send({ personalNumber: 'N2' }).expect(409);
    expect(num.body.error.code).toBe('number_taken');
    const cleared = await f.api().patch(`/api/v1/members/${m._id}`).set(A()).send({ phone: null }).expect(200);
    expect(cleared.body.phoneMasked).toBeUndefined();
  });

  test('role change inside an edit needs member.role.assign; stale version → stale_write', async () => {
    const m = await f.member(tenant, det, { name: 'عضو للتعديل' });
    const editor = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.edit'] } });
    const denied = await f.api().patch(`/api/v1/members/${m._id}`).set(f.auth(editor.token)).send({ role: 'lead' }).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
    const same = await f.api().patch(`/api/v1/members/${m._id}`).set(f.auth(editor.token)).send({ role: 'volunteer', department: 'دعم' }).expect(200);
    expect(same.body).toMatchObject({ role: 'member', department: 'دعم' });

    await f.api().patch(`/api/v1/members/${m._id}`).set(A()).send({ department: 'أ', version: 2 }).expect(200);
    const stale = await f.api().patch(`/api/v1/members/${m._id}`).set(A()).send({ department: 'ب', version: 2 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_write', currentVersion: 3 });
    expect(stale.body.error.currentRecord.department).toBe('أ');
  });
});

describe('role / attendance / lifecycle / delete', () => {
  test('PATCH role maps legacy; needs member.role.assign', async () => {
    const m = await f.member(tenant, det);
    const res = await f.api().patch(`/api/v1/members/${m._id}/role`).set(A()).send({ role: 'trainee' }).expect(200);
    expect(res.body.role).toBe('followUp');
    await f.api().patch(`/api/v1/members/${m._id}/role`).set(A()).send({ role: 'boss' }).expect(422);
    const editor = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.edit'] } });
    await f.api().patch(`/api/v1/members/${m._id}/role`).set(f.auth(editor.token)).send({ role: 'member' }).expect(403);
  });

  test('PATCH attendance maps legacy; needs shift.attendance.record', async () => {
    const m = await f.member(tenant, det);
    const res = await f.api().patch(`/api/v1/members/${m._id}/attendance`).set(A()).send({ attendance: 'present' }).expect(200);
    expect(res.body.attendance).toBe('checkedIn');
    await f.api().patch(`/api/v1/members/${m._id}/attendance`).set(A()).send({ attendance: 'sleeping' }).expect(422);
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.view'] } });
    await f.api().patch(`/api/v1/members/${m._id}/attendance`).set(f.auth(viewer.token)).send({ attendance: 'absent' }).expect(403);
  });

  test('deactivate / reactivate (limit checked on reactivate)', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const d2 = await f.detachment(t2);
    const m = await f.member(t2, d2);
    const off = await f.api().post(`/api/v1/members/${m._id}/deactivate`).set(f.auth(m2.token)).expect(200);
    expect(off.body.active).toBe(false);
    await f.member(t2, d2);
    await setLimit(t2, 'members', 1);
    const limited = await f.api().post(`/api/v1/members/${m._id}/reactivate`).set(f.auth(m2.token)).expect(409);
    expect(limited.body.error.code).toBe('plan_limit_reached');
    await setLimit(t2, 'members', 10);
    const on = await f.api().post(`/api/v1/members/${m._id}/reactivate`).set(f.auth(m2.token)).expect(200);
    expect(on.body.active).toBe(true);
    const editor = await f.simpleAdmin(t2, { global: [], scoped: { [d2._id]: ['member.edit'] } });
    await f.api().post(`/api/v1/members/${m._id}/deactivate`).set(f.auth(editor.token)).expect(403);
  });

  test('DELETE → 204, photo removed, change log records the delete; shift lines keep the id', async () => {
    const m = await f.member(tenant, det);
    const sh = await f.shift(tenant, det, { attendees: [{ memberId: m._id }] });
    await f.api().post(`/api/v1/members/${m._id}/photo`).set(A()).attach('image', png, 'p.png').expect(200);
    const viewer = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['member.edit'] } });
    await f.api().delete(`/api/v1/members/${m._id}`).set(f.auth(viewer.token)).expect(403);
    await f.api().delete(`/api/v1/members/${m._id}`).set(A()).expect(204);
    expect(await TeamMember.countDocuments({ _id: m._id })).toBe(0);
    expect(await StoredFile.countDocuments({ ownerType: 'member', ownerId: String(m._id) })).toBe(0);
    expect(await ChangeLog.countDocuments({ entityId: String(m._id), op: 'delete' })).toBe(1);
    const shift = await f.models.Shift.findById(sh._id);
    expect(shift.attendees[0].memberId).toBe(String(m._id));
    await f.api().get(`/api/v1/members/${m._id}`).set(A()).expect(404);
  });

  test('photo upload → photoUrl; delete photo; missing file → 422', async () => {
    const m = await f.member(tenant, det);
    const up = await f.api().post(`/api/v1/members/${m._id}/photo`).set(A()).attach('image', png, 'p.png').expect(200);
    expect(up.body.photoUrl).toMatch(/\/images\/members\/member-.*\.webp$/);
    const none = await f.api().post(`/api/v1/members/${m._id}/photo`).set(A()).expect(422);
    expect(none.body.error.code).toBe('validation');
    const del = await f.api().delete(`/api/v1/members/${m._id}/photo`).set(A()).expect(200);
    expect(del.body.photoUrl).toBeUndefined();
    expect(await StoredFile.countDocuments({ ownerType: 'member', ownerId: String(m._id) })).toBe(0);
  });
});
