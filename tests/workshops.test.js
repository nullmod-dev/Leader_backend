/**
 * Workshops: CRUD, archive, cover, the register (team members, guests, legacy
 * roster lines), organisers, stats, CSV export, features and capabilities.
 */
const f = require('./helpers/factory');

let tenant;
let main;
let det;

const W = '/api/v1/workshops';
const P = '/api/v1/workshop-participants';
const withCaps = (global) => f.simpleAdmin(tenant, { global, scoped: {} });

const addTeam = (w, body, token = main.token) => f.api().post(`${W}/${w._id}/team-members`).set(f.auth(token)).send(body);
const addGuest = (w, body, token = main.token) => f.api().post(`${W}/${w._id}/guests`).set(f.auth(token)).send(body);

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  det = await f.detachment(tenant);
});

describe('features, surface, capabilities', () => {
  test('workshops disabled → 403 feature_disabled; super_admin → 403 tenant_context_unavailable', async () => {
    const t = await f.createTenant();
    t.features.find((x) => x.key === 'workshops').enabled = false;
    await t.save();
    const admin = await f.mainAdmin(t);
    const res = await f.api().get(W).set(f.auth(admin.token)).expect(403);
    expect(res.body.error.code).toBe('feature_disabled');
    const sa = await f.superAdmin();
    const r2 = await f.api().get(W).set(f.auth(sa.token)).expect(403);
    expect(r2.body.error.code).toBe('tenant_context_unavailable');
  });

  test('create needs workshop.create (global); plan limit → 409 plan_limit_reached', async () => {
    const nobody = await withCaps([]);
    const body = { name: 'ورشة', at: '2031-01-01T09:00:00Z', location: 'قاعة', capacity: 5 };
    const r = await f.api().post(W).set(f.auth(nobody.token)).send(body).expect(403);
    expect(r.body.error.code).toBe('not_permitted');
    // A scoped grant never carries workshop.* keys.
    const scoped = await f.simpleAdmin(tenant, { global: [], scoped: { [String(det._id)]: ['workshop.create', 'detachment.view'] } });
    await f.api().post(W).set(f.auth(scoped.token)).send(body).expect(403);

    const t = await f.createTenant();
    t.subscription.limitOverrides.set('workshops', 1);
    await t.save();
    const admin = await f.mainAdmin(t);
    await f.api().post(W).set(f.auth(admin.token)).send(body).expect(201);
    const lim = await f.api().post(W).set(f.auth(admin.token)).send(body).expect(409);
    expect(lim.body.error).toMatchObject({ code: 'plan_limit_reached', limitKey: 'workshops', limit: 1, usage: 1 });
  });
});

describe('workshop records', () => {
  test('create → 201 scheduled, no organisers; validation', async () => {
    const res = await f
      .api()
      .post(W)
      .set(f.auth(main.token))
      .send({ name: '  الإسعاف   الأولي ', at: '2031-02-01T10:00:00', location: ' قاعة الشعلان ', capacity: 20, registrationFee: 25000 })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'الإسعاف الأولي',
      location: 'قاعة الشعلان',
      capacity: 20,
      registered: 0,
      guests: 0,
      status: 'scheduled',
      registrationFee: 25000,
      archived: false,
      organizingTeam: [],
      version: 1,
    });
    // No offset → read in the tenant timezone (Asia/Damascus, UTC+3).
    expect(res.body.at).toBe('2031-02-01T07:00:00.000Z');
    const free = await f.api().post(W).set(f.auth(main.token)).send({ name: 'مجانية', at: '2031-02-02T10:00:00Z', location: 'قاعة', capacity: 3 }).expect(201);
    expect(free.body.registrationFee).toBe(0);

    const base = { name: 'x', at: '2031-02-01T10:00:00Z', location: 'y', capacity: 2 };
    for (const bad of [{ name: '   ' }, { location: '' }, { capacity: 0 }, { registrationFee: -1 }, { at: 'soon' }, { capacity: 1.5 }]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await f.api().post(W).set(f.auth(main.token)).send({ ...base, ...bad }).expect(422);
      expect(r.body.error.code).toBe('validation');
    }
  });

  test('list: sorted by at; buckets; folded query', async () => {
    const t = await f.createTenant();
    const admin = await f.mainAdmin(t);
    const day = 86400000;
    const past = await f.workshop(t, { name: 'إنعاش قلبي رئوي', at: new Date(Date.now() - 3 * day), location: 'قاعة داريا' });
    const soon = await f.workshop(t, { name: 'فرز المصابين', at: new Date(Date.now() + day) });
    const later = await f.workshop(t, { name: 'إدارة الحوادث', at: new Date(Date.now() + 9 * day) });
    const archived = await f.workshop(t, { name: 'قديمة', at: new Date(Date.now() + 2 * day), archived: true });
    const ids = (r) => r.body.map((w) => w.id);
    expect(ids(await f.api().get(W).set(f.auth(admin.token)).expect(200))).toEqual([past, soon, archived, later].map((w) => String(w._id)));
    expect(ids(await f.api().get(W).query({ bucket: 'upcoming' }).set(f.auth(admin.token)).expect(200))).toEqual([soon, later].map((w) => String(w._id)));
    expect(ids(await f.api().get(W).query({ bucket: 'past' }).set(f.auth(admin.token)).expect(200))).toEqual([String(past._id)]);
    expect(ids(await f.api().get(W).query({ bucket: 'archived' }).set(f.auth(admin.token)).expect(200))).toEqual([String(archived._id)]);
    // alef-hamza folding: "انعاش" matches "إنعاش"; location is searched too.
    expect(ids(await f.api().get(W).query({ query: 'انعاش' }).set(f.auth(admin.token)).expect(200))).toEqual([String(past._id)]);
    expect(ids(await f.api().get(W).query({ query: 'داريا' }).set(f.auth(admin.token)).expect(200))).toEqual([String(past._id)]);
    await f.api().get(W).query({ bucket: 'soon' }).set(f.auth(admin.token)).expect(422);
  });

  test('get → Workshop with derived counts; unknown / foreign → 404', async () => {
    const w = await f.workshop(tenant);
    await addTeam(w, { name: 'نور الحسن', role: 'trainer', paid: true }).expect(201);
    await addGuest(w, { name: 'زيد الحلبي' }).expect(201);
    const res = await f.api().get(`${W}/${w._id}`).set(f.auth(main.token)).expect(200);
    expect(res.body).toMatchObject({ id: String(w._id), registered: 2, guests: 1 });
    await f.api().get(`${W}/w_missing`).set(f.auth(main.token)).expect(404);
    const other = await f.tenantWithMainAdmin();
    await f.api().get(`${W}/${w._id}`).set(f.auth(other.main.token)).expect(404);
  });

  test('update: editable fields only; capacity rules; body id; stale version', async () => {
    const w = await f.workshop(tenant, { capacity: 5 });
    await addGuest(w, { name: 'أ' }).expect(201);
    await addGuest(w, { name: 'ب' }).expect(201);
    const res = await f
      .api()
      .put(`${W}/${w._id}`)
      .set(f.auth(main.token))
      .send({
        id: String(w._id),
        name: 'اسم جديد',
        at: '2031-03-01T09:00:00Z',
        location: 'مكان جديد',
        capacity: 2,
        status: 'ongoing',
        registrationFee: 1000,
        registered: 99,
        guests: 99,
        archived: true,
        organizingTeam: [{ id: 'm_x' }],
        version: 1,
      })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'اسم جديد', capacity: 2, status: 'ongoing', registrationFee: 1000, registered: 2, guests: 2, archived: false, organizingTeam: [], version: 2 });

    const below = await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ capacity: 1 }).expect(409);
    expect(below.body.error).toMatchObject({ code: 'capacity_below_registered', registered: 2 });
    await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ capacity: 0 }).expect(422);
    await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ status: 'cancelled' }).expect(422);
    await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ id: 'w_other', name: 'x' }).expect(422);
    const stale = await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ name: 'x', version: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_write', currentVersion: 2 });
    expect(stale.body.error.currentRecord.registered).toBe(2);
    const editor = await withCaps(['workshop.create']);
    await f.api().patch(`${W}/${w._id}`).set(f.auth(editor.token)).send({ name: 'x' }).expect(403);
  });

  test('archive: every mutation → 409 archived; archive is idempotent; restore works', async () => {
    const w = await f.workshop(tenant);
    const m = await f.member(tenant, det);
    const line = await addTeam(w, { name: 'عضو', role: 'member', paid: false }).expect(201);
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(m._id)] }).expect(200);

    const arch = await f.api().patch(`${W}/${w._id}/archive`).set(f.auth(main.token)).send({ archived: true }).expect(200);
    expect(arch.body.archived).toBe(true);
    const again = await f.api().patch(`${W}/${w._id}/archive`).set(f.auth(main.token)).send({ archived: true }).expect(200);
    expect(again.body.version).toBe(arch.body.version);

    const pid = line.body.id;
    const attempts = [
      f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ name: 'x' }),
      addTeam(w, { name: 'جديد', role: 'member', paid: false }),
      addGuest(w, { name: 'ضيف' }),
      f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(m._id)] }),
      f.api().put(`${P}/${pid}`).set(f.auth(main.token)).send({ name: 'x', role: 'member', paid: true }),
      f.api().delete(`${P}/${pid}`).set(f.auth(main.token)),
      f.api().patch(`${P}/${pid}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedIn' }),
      f.api().patch(`${P}/${pid}/payment`).set(f.auth(main.token)).send({ paymentStatus: 'paid' }),
      f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: ['m_any'] }),
      f.api().delete(`${W}/${w._id}/organizers/${m._id}`).set(f.auth(main.token)),
      f.api().patch(`${W}/${w._id}/organizers/${m._id}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedIn' }),
      f.api().delete(`${W}/${w._id}/cover`).set(f.auth(main.token)),
    ];
    for (const req of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const r = await req;
      expect([r.status, r.body.error && r.body.error.code]).toEqual([409, 'archived']);
    }
    // Reads keep working.
    await f.api().get(`${W}/${w._id}/participants`).set(f.auth(main.token)).expect(200);

    const nobody = await withCaps(['workshop.edit']);
    await f.api().patch(`${W}/${w._id}/archive`).set(f.auth(nobody.token)).send({ archived: false }).expect(403);
    const restored = await f.api().patch(`${W}/${w._id}/archive`).set(f.auth(main.token)).send({ archived: false }).expect(200);
    expect(restored.body.archived).toBe(false);
    await f.api().patch(`${W}/${w._id}`).set(f.auth(main.token)).send({ name: 'بعد الاستعادة' }).expect(200);
    await f.api().patch(`${W}/${w._id}/archive`).set(f.auth(main.token)).send({}).expect(422);
  });

  test('cover: upload (multipart image) and delete', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#2a7' } }).png().toBuffer();
    const w = await f.workshop(tenant);
    const up = await f.api().post(`${W}/${w._id}/cover`).set(f.auth(main.token)).attach('image', png, 'cover.png').expect(200);
    expect(up.body.coverImageUrl).toMatch(/\/images\/workshops\/workshop-.*\.webp$/);
    await f.api().post(`${W}/${w._id}/cover`).set(f.auth(main.token)).expect(422);
    const del = await f.api().delete(`${W}/${w._id}/cover`).set(f.auth(main.token)).expect(200);
    expect(del.body.coverImageUrl).toBeUndefined();
    expect(await f.models.StoredFile.countDocuments({ ownerId: String(w._id) })).toBe(0);
  });
});

describe('register', () => {
  test('team members: 201 line; validation; duplicate within members only; full', async () => {
    const w = await f.workshop(tenant, { capacity: 3 });
    const res = await addTeam(w, { name: '  نور   الحسن ', role: 'trainer', paid: true }).expect(201);
    expect(res.body).toMatchObject({ workshopId: String(w._id), name: 'نور الحسن', kind: 'member', role: 'trainer', attendance: 'notCheckedIn', paymentStatus: 'paid' });
    expect(res.body.memberId).toBeUndefined();
    expect(res.body.initials).toBeTruthy();

    expect((await addTeam(w, { name: '   ', role: 'trainer', paid: true }).expect(422)).body.error.fields).toHaveProperty('name');
    expect((await addTeam(w, { name: 'س', role: 'boss', paid: true }).expect(422)).body.error.fields).toHaveProperty('role');
    const dup = await addTeam(w, { name: 'نور  الحسن', role: 'member', paid: false }).expect(409);
    expect(dup.body.error.code).toBe('duplicate');
    // A guest of the same name does not collide with a team member.
    const guest = await addGuest(w, { name: 'نور الحسن' }).expect(201);
    expect(guest.body).toMatchObject({ kind: 'guest', paymentStatus: 'unpaid' });
    expect(guest.body.role).toBeUndefined();
    const dupGuest = await addGuest(w, { name: 'نور الحسن', paid: true }).expect(409);
    expect(dupGuest.body.error.code).toBe('duplicate');
    await addGuest(w, { name: 'ثالث' }).expect(201);
    const full = await addTeam(w, { name: 'رابع', role: 'member', paid: false }).expect(409);
    expect(full.body.error.code).toBe('workshop_full');
    expect((await addGuest(w, { name: 'خامس' }).expect(409)).body.error.code).toBe('workshop_full');

    const nobody = await withCaps(['workshop.edit']);
    await addTeam(w, { name: 'ممنوع', role: 'member', paid: false }, nobody.token).expect(403);
  });

  test('concurrent adds cannot overbook the last seat', async () => {
    const w = await f.workshop(tenant, { capacity: 2 });
    await addGuest(w, { name: 'أول' }).expect(201);
    const results = await Promise.all(['ثان', 'ثالث', 'رابع'].map((name) => addGuest(w, { name })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await f.models.WorkshopParticipant.countDocuments({ workshopId: String(w._id) })).toBe(2);
  });

  test('legacy roster registration is all or nothing', async () => {
    const w = await f.workshop(tenant, { capacity: 3 });
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => f.member(tenant, det)));
    const unknown = await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(a._id), 'm_ghost'] }).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
    expect(await f.models.WorkshopParticipant.countDocuments({ workshopId: String(w._id) })).toBe(0);

    const ok = await f
      .api()
      .post(`${W}/${w._id}/participants`)
      .set(f.auth(main.token))
      .send({ memberIds: [String(a._id), String(a._id), String(b._id)] })
      .expect(201);
    expect(ok.body).toHaveLength(2);
    expect(ok.body[0]).toMatchObject({ kind: 'member', role: 'member', memberId: String(a._id), name: a.name, paymentStatus: 'unpaid', attendance: 'notCheckedIn' });

    const dup = await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(c._id), String(b._id)] }).expect(409);
    expect(dup.body.error.code).toBe('duplicate');
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(d._id)] }).expect(200);
    const org = await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(c._id), String(d._id)] }).expect(409);
    expect(org.body.error.code).toBe('already_organizer');
    const e = await f.member(tenant, det);
    const full = await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(c._id), String(e._id)] }).expect(409);
    expect(full.body.error.code).toBe('workshop_full');
    expect(await f.models.WorkshopParticipant.countDocuments({ workshopId: String(w._id) })).toBe(2);
    await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [] }).expect(422);
  });

  test('update a team-member line; guests are not editable; duplicate excludes itself', async () => {
    const w = await f.workshop(tenant);
    const a = (await addTeam(w, { name: 'أحمد كنعان', role: 'leader', paid: false }).expect(201)).body;
    await addTeam(w, { name: 'ليلى ياسين', role: 'member', paid: false }).expect(201);
    const g = (await addGuest(w, { name: 'ضيف' }).expect(201)).body;
    await f.api().patch(`${P}/${a.id}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedIn' }).expect(200);

    const res = await f.api().put(`${P}/${a.id}`).set(f.auth(main.token)).send({ name: 'أحمد  كنعان', role: 'trainer', paid: true }).expect(200);
    expect(res.body).toMatchObject({ name: 'أحمد كنعان', role: 'trainer', paymentStatus: 'paid', attendance: 'checkedIn' });
    const dup = await f.api().put(`${P}/${a.id}`).set(f.auth(main.token)).send({ name: 'ليلى ياسين', role: 'trainer', paid: true }).expect(409);
    expect(dup.body.error.code).toBe('duplicate');
    await f.api().put(`${P}/${g.id}`).set(f.auth(main.token)).send({ name: 'ضيف آخر', role: 'member', paid: true }).expect(404);
    await f.api().put(`${P}/${a.id}`).set(f.auth(main.token)).send({ name: '', role: 'trainer', paid: true }).expect(422);
    await f.api().put(`${P}/p_missing`).set(f.auth(main.token)).send({ name: 'x', role: 'trainer', paid: true }).expect(404);
  });

  test('remove a line → 204; the TeamMember behind a legacy line is untouched', async () => {
    const w = await f.workshop(tenant);
    const m = await f.member(tenant, det);
    const [line] = (await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(m._id)] }).expect(201)).body;
    await f.api().delete(`${P}/${line.id}`).set(f.auth(main.token)).expect(204);
    const still = await f.models.TeamMember.findById(m._id);
    expect(still.active).toBe(true);
    await f.api().delete(`${P}/${line.id}`).set(f.auth(main.token)).expect(404);
  });

  test('attendance (aliases) and payment (incl. null) need their own capabilities', async () => {
    const w = await f.workshop(tenant);
    const line = (await addGuest(w, { name: 'زائر' }).expect(201)).body;
    const att = await f.api().patch(`${P}/${line.id}/attendance`).set(f.auth(main.token)).send({ attendance: 'present' }).expect(200);
    expect(att.body.attendance).toBe('checkedIn');
    await f.api().patch(`${P}/${line.id}/attendance`).set(f.auth(main.token)).send({ attendance: 'nope' }).expect(422);
    const paid = await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(main.token)).send({ paymentStatus: 'paid' }).expect(200);
    expect(paid.body.paymentStatus).toBe('paid');
    const cleared = await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(main.token)).send({ paymentStatus: null }).expect(200);
    expect(cleared.body.paymentStatus).toBeUndefined();
    await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(main.token)).send({ paymentStatus: 'maybe' }).expect(422);
    const stale = await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(main.token)).send({ paymentStatus: 'paid', version: 1 }).expect(409);
    expect(stale.body.error.code).toBe('stale_write');

    const recorder = await withCaps(['workshop.attendance.record']);
    await f.api().patch(`${P}/${line.id}/attendance`).set(f.auth(recorder.token)).send({ attendance: 'absent' }).expect(200);
    await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(recorder.token)).send({ paymentStatus: 'paid' }).expect(403);
    const cashier = await withCaps(['workshop.payment.record']);
    await f.api().patch(`${P}/${line.id}/payment`).set(f.auth(cashier.token)).send({ paymentStatus: 'paid' }).expect(200);
    await f.api().patch(`${P}/${line.id}/attendance`).set(f.auth(cashier.token)).send({ attendance: 'absent' }).expect(403);
  });

  test('participants list: members first, then guests, each in creation order', async () => {
    const w = await f.workshop(tenant);
    const g1 = (await addGuest(w, { name: 'ضيف ١' }).expect(201)).body;
    const m1 = (await addTeam(w, { name: 'عضو ١', role: 'member', paid: false }).expect(201)).body;
    const g2 = (await addGuest(w, { name: 'ضيف ٢' }).expect(201)).body;
    const m2 = (await addTeam(w, { name: 'عضو ٢', role: 'leader', paid: true }).expect(201)).body;
    const res = await f.api().get(`${W}/${w._id}/participants`).set(f.auth(main.token)).expect(200);
    expect(res.body.map((p) => p.id)).toEqual([m1.id, m2.id, g1.id, g2.id]);
    await f.api().get(`${W}/w_missing/participants`).set(f.auth(main.token)).expect(404);
  });
});

describe('organising team', () => {
  test('add (all or nothing, no seat limit), exclusivity, remove, attendance', async () => {
    const w = await f.workshop(tenant, { capacity: 1 });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => f.member(tenant, det)));
    await f.api().post(`${W}/${w._id}/participants`).set(f.auth(main.token)).send({ memberIds: [String(c._id)] }).expect(201);

    const res = await f
      .api()
      .post(`${W}/${w._id}/organizers`)
      .set(f.auth(main.token))
      .send({ memberIds: [String(a._id), String(b._id), String(a._id)] })
      .expect(200);
    expect(res.body.organizingTeam.map((o) => o.id)).toEqual([String(a._id), String(b._id)]);
    expect(res.body.organizingTeam[0].attendance).toBe('notCheckedIn');
    expect(res.body.registered).toBe(1);

    expect((await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: ['m_ghost'] }).expect(404)).body.error.code).toBe('not_found');
    expect((await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(a._id)] }).expect(409)).body.error.code).toBe('duplicate');
    expect((await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(c._id)] }).expect(409)).body.error.code).toBe('already_participant');
    const d = await f.member(tenant, det);
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(d._id), 'm_ghost'] }).expect(404);
    expect((await f.models.Workshop.findById(w._id)).organizingTeam).toHaveLength(2);

    const att = await f.api().patch(`${W}/${w._id}/organizers/${a._id}/attendance`).set(f.auth(main.token)).send({ attendance: 'present' }).expect(200);
    expect(att.body.organizingTeam[0].attendance).toBe('checkedIn');
    await f.api().patch(`${W}/${w._id}/organizers/${c._id}/attendance`).set(f.auth(main.token)).send({ attendance: 'absent' }).expect(404);

    const rm = await f.api().delete(`${W}/${w._id}/organizers/${a._id}`).set(f.auth(main.token)).expect(200);
    expect(rm.body.organizingTeam.map((o) => o.id)).toEqual([String(b._id)]);
    await f.api().delete(`${W}/${w._id}/organizers/${a._id}`).set(f.auth(main.token)).expect(404);

    // Concurrent array edits of one workshop: a lost race is 409 stale_write, never a 500.
    const e1 = await f.member(tenant, det);
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(e1._id)] }).expect(200);
    const race = await Promise.all(
      [b, e1].map((m) => f.api().patch(`${W}/${w._id}/organizers/${m._id}/attendance`).set(f.auth(main.token)).send({ attendance: 'absent' })),
    );
    race.forEach((r) => {
      expect([200, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe('stale_write');
    });

    const recorder = await withCaps(['workshop.attendance.record']);
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(recorder.token)).send({ memberIds: [String(a._id)] }).expect(403);
    await f.api().patch(`${W}/${w._id}/organizers/${b._id}/attendance`).set(f.auth(recorder.token)).send({ attendance: 'checkedOut' }).expect(200);
  });
});

describe('stats + export', () => {
  test('stats reproduce workshop_stats.dart', async () => {
    const w = await f.workshop(tenant, { capacity: 8, registrationFee: 25000 });
    const lead = await f.member(tenant, det, { role: 'shiftSupervisor', name: 'ليلى ياسين' });
    const admin = await f.member(tenant, det, { role: 'administrator' });
    await f.api().post(`${W}/${w._id}/organizers`).set(f.auth(main.token)).send({ memberIds: [String(lead._id), String(admin._id)] }).expect(200);
    await f.api().patch(`${W}/${w._id}/organizers/${lead._id}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedIn' }).expect(200);

    const lines = [];
    lines.push((await addTeam(w, { name: 'أ', role: 'leader', paid: true }).expect(201)).body); // checkedIn, paid
    lines.push((await addTeam(w, { name: 'ب', role: 'trainer', paid: true }).expect(201)).body); // checkedOut, paid
    lines.push((await addTeam(w, { name: 'ج', role: 'member', paid: false }).expect(201)).body); // absent, unpaid
    lines.push((await addGuest(w, { name: 'د', paid: true }).expect(201)).body); // notCheckedIn, paid
    lines.push((await addGuest(w, { name: 'هـ' }).expect(201)).body); // payment → null
    await f.api().patch(`${P}/${lines[0].id}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedIn' }).expect(200);
    await f.api().patch(`${P}/${lines[1].id}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedOut' }).expect(200);
    await f.api().patch(`${P}/${lines[2].id}/attendance`).set(f.auth(main.token)).send({ attendance: 'absent' }).expect(200);
    await f.api().patch(`${P}/${lines[4].id}/payment`).set(f.auth(main.token)).send({ paymentStatus: null }).expect(200);

    const res = await f.api().get(`${W}/${w._id}/stats`).set(f.auth(main.token)).expect(200);
    expect(res.body).toMatchObject({
      workshopId: String(w._id),
      registrationFee: 25000,
      isFree: false,
      capacity: 8,
      registeredCount: 5,
      capacityPercent: 63, // round(5/8 × 100) = round(62.5)
      participants: { total: 5, present: 2, absent: 3, percent: 40, paid: 3, unpaid: 2 },
      team: { total: 2, present: 1, absent: 1, percent: 50 },
      totalPaidAmount: 75000,
    });
    expect(res.body.people).toHaveLength(7);
    expect(res.body.people[0]).toMatchObject({ id: lines[0].id, group: 'participant', role: 'leader', attendance: 'checkedIn', paymentStatus: 'paid' });
    expect(res.body.people.find((p) => p.id === lines[4].id)).toMatchObject({ role: 'guest', paymentStatus: null });
    expect(res.body.people[5]).toMatchObject({ id: String(lead._id), name: 'ليلى ياسين', group: 'team', role: 'shiftSupervisor', attendance: 'checkedIn', paymentStatus: null });

    const empty = await f.workshop(tenant, { registrationFee: 0 });
    const e = await f.api().get(`${W}/${empty._id}/stats`).set(f.auth(main.token)).expect(200);
    expect(e.body).toMatchObject({ isFree: true, registeredCount: 0, capacityPercent: 0, participants: { total: 0, percent: 0 }, team: { total: 0, percent: 0 }, totalPaidAmount: 0 });
  });

  test('stats needs statistics_reports', async () => {
    const t = await f.createTenant();
    t.features.find((x) => x.key === 'statistics_reports').enabled = false;
    await t.save();
    const admin = await f.mainAdmin(t);
    const w = await f.workshop(t);
    await f.api().get(`${W}/${w._id}`).set(f.auth(admin.token)).expect(200);
    const res = await f.api().get(`${W}/${w._id}/stats`).set(f.auth(admin.token)).expect(403);
    expect(res.body.error).toMatchObject({ code: 'feature_disabled', feature: 'statistics_reports' });
  });

  test('export.csv: UTF-8 with BOM, one row per register line', async () => {
    const w = await f.workshop(tenant);
    await addTeam(w, { name: 'نور، الحسن', role: 'trainer', paid: true }).expect(201);
    await addGuest(w, { name: '=cmd' }).expect(201);
    const res = await f
      .api()
      .get(`${W}/${w._id}/export.csv`)
      .set(f.auth(main.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const buf = res.body;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toEqual(['name,kind,role,attendance,payment', 'نور، الحسن,member,trainer,notCheckedIn,paid', "'=cmd,guest,,notCheckedIn,unpaid"]);
  });
});
