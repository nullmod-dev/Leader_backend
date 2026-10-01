/**
 * Shifts: schedule reads, create (+ repeat), update, delete, copy, templates,
 * assignment, candidates, quick-fill. Attendance lives in attendance.test.js.
 */
const f = require('./helpers/factory');
const { todayIn, addDays, weekStartOf, shiftWindow } = require('../utils/time');

let tenant;
let main;
let det;
let tz;

const url = (d = det) => `/api/v1/detachments/${d._id}`;
const scoped = (d, keys) => f.simpleAdmin(tenant, { global: [], scoped: { [String(d._id)]: keys } });

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  tz = tenant.timezone || 'Asia/Damascus';
  det = await f.detachment(tenant);
});

describe('schedule reads', () => {
  test('GET /shifts/today → today only, sorted by startMinutes, with attendanceClosesAt', async () => {
    const d = await f.detachment(tenant);
    const today = todayIn(tz);
    const late = await f.shift(tenant, d, { startMinutes: 900, endMinutes: 1200 });
    const early = await f.shift(tenant, d, { startMinutes: 480, endMinutes: 840 });
    await f.shift(tenant, d, { date: addDays(today, 1) });
    const res = await f.api().get(`${url(d)}/shifts/today`).set(f.auth(main.token)).expect(200);
    expect(res.body.map((s) => s.id)).toEqual([String(early._id), String(late._id)]);
    const s = res.body[0];
    expect(s).toMatchObject({ date: today, detachmentId: String(d._id), startMinutes: 480, endMinutes: 840, assigned: 0, hasCoverageGap: true });
    expect(new Date(s.attendanceClosesAt).getTime() - new Date(s.endsAt).getTime()).toBe(60 * 60000);
  });

  test('GET /shifts?from&to → inclusive range sorted by date then start; bounds validated', async () => {
    const d = await f.detachment(tenant);
    const a = await f.shift(tenant, d, { date: '2030-03-02', startMinutes: 600, endMinutes: 700 });
    const b = await f.shift(tenant, d, { date: '2030-03-01', startMinutes: 900, endMinutes: 1000 });
    const c = await f.shift(tenant, d, { date: '2030-03-02', startMinutes: 100, endMinutes: 200 });
    await f.shift(tenant, d, { date: '2030-03-04' });
    const res = await f.api().get(`${url(d)}/shifts`).query({ from: '2030-03-01', to: '2030-03-03' }).set(f.auth(main.token)).expect(200);
    expect(res.body.map((s) => s.id)).toEqual([b, c, a].map((s) => String(s._id)));

    const missing = await f.api().get(`${url(d)}/shifts`).query({ from: '2030-03-01' }).set(f.auth(main.token)).expect(422);
    expect(missing.body.error.fields).toHaveProperty('to');
    await f.api().get(`${url(d)}/shifts`).query({ from: '2030-03-05', to: '2030-03-01' }).set(f.auth(main.token)).expect(422);
    await f.api().get(`${url(d)}/shifts`).query({ from: '2030-01-01', to: '2030-03-04' }).set(f.auth(main.token)).expect(422);
    await f.api().get(`${url(d)}/shifts`).query({ from: '2030-01-01', to: '2030-03-03' }).set(f.auth(main.token)).expect(200);
    await f.api().get(`${url(d)}/shifts`).query({ from: 'yesterday', to: '2030-03-03' }).set(f.auth(main.token)).expect(422);
  });

  test('GET /shifts/week → Saturday-normalized week, 7 days, summary', async () => {
    const d = await f.detachment(tenant);
    const m1 = await f.member(tenant, d);
    const m2 = await f.member(tenant, d);
    const m3 = await f.member(tenant, d);
    // 2031-01-04 is a Saturday; ask with the Wednesday after it.
    await f.shift(tenant, d, { date: '2031-01-04', needed: 3, attendees: [{ memberId: String(m1._id) }] });
    await f.shift(tenant, d, {
      date: '2031-01-10',
      needed: 2,
      attendees: [{ memberId: String(m1._id) }, { memberId: String(m2._id) }, { memberId: String(m3._id) }],
    });
    await f.shift(tenant, d, { date: '2031-01-11' }); // next week
    const res = await f.api().get(`${url(d)}/shifts/week`).query({ weekStart: '2031-01-08' }).set(f.auth(main.token)).expect(200);
    expect(res.body.weekStart).toBe('2031-01-04');
    expect(res.body.days).toEqual(['2031-01-04', '2031-01-05', '2031-01-06', '2031-01-07', '2031-01-08', '2031-01-09', '2031-01-10']);
    expect(res.body.shifts).toHaveLength(2);
    // assigned = min(1,3) + min(3,2) = 3 of 5 needed; gaps = 2 + 0
    expect(res.body.summary).toEqual({ shiftCount: 2, needed: 5, assigned: 3, coveragePercent: 60, gaps: 2 });
  });

  test('week defaults to the current week', async () => {
    const res = await f.api().get(`${url()}/shifts/week`).set(f.auth(main.token)).expect(200);
    expect(res.body.weekStart).toBe(weekStartOf(todayIn(tz)));
    expect(res.body.summary.coveragePercent).toBeGreaterThanOrEqual(0);
  });

  test('unknown or foreign detachment → 404; no view → 403; super_admin → 403 tenant_context_unavailable', async () => {
    await f.api().get('/api/v1/detachments/d_nope/shifts/today').set(f.auth(main.token)).expect(404);
    const other = await f.createTenant();
    const foreign = await f.detachment(other);
    const r404 = await f.api().get(`${url(foreign)}/shifts/today`).set(f.auth(main.token)).expect(404);
    expect(r404.body.error.code).toBe('not_found');

    const elsewhere = await f.detachment(tenant);
    const admin = await scoped(elsewhere, ['detachment.view']);
    const r403 = await f.api().get(`${url()}/shifts/today`).set(f.auth(admin.token)).expect(403);
    expect(r403.body.error.code).toBe('not_permitted');
    await f.api().get(`${url(elsewhere)}/shifts/today`).set(f.auth(admin.token)).expect(200);

    const sa = await f.superAdmin();
    const rsa = await f.api().get(`${url()}/shifts/today`).set(f.auth(sa.token)).expect(403);
    expect(rsa.body.error.code).toBe('tenant_context_unavailable');
  });
});

describe('create', () => {
  test('standalone shift → 201 with a server-computed window', async () => {
    const res = await f
      .api()
      .post(`${url()}/shifts`)
      .set(f.auth(main.token))
      .send({ date: '2030-05-10T00:00:00.000', centerName: '  مركز   المهاجرين ', startMinutes: 1200, endMinutes: 120, needed: 4 })
      .expect(201);
    const w = shiftWindow('2030-05-10', 1200, 120, tz);
    expect(res.body).toMatchObject({
      date: '2030-05-10',
      centerName: 'مركز المهاجرين',
      startMinutes: 1200,
      endMinutes: 120,
      needed: 4,
      attendees: [],
      crossesMidnight: true,
      version: 1,
      startsAt: w.startsAt.toISOString(),
      endsAt: w.endsAt.toISOString(),
    });
    expect(res.body.templateId).toBeUndefined();
  });

  test('validation: equal times, needed ≤ 0, blank centre, missing date', async () => {
    const body = { date: '2030-05-11', centerName: 'مركز', startMinutes: 480, endMinutes: 840, needed: 2 };
    const eq = await f.api().post(`${url()}/shifts`).set(f.auth(main.token)).send({ ...body, endMinutes: 480 }).expect(422);
    expect(eq.body.error.fields).toHaveProperty('endMinutes');
    const needed = await f.api().post(`${url()}/shifts`).set(f.auth(main.token)).send({ ...body, needed: 0 }).expect(422);
    expect(needed.body.error.fields).toHaveProperty('needed');
    const blank = await f.api().post(`${url()}/shifts`).set(f.auth(main.token)).send({ ...body, centerName: '   ' }).expect(422);
    expect(blank.body.error.fields).toHaveProperty('centerName');
    const noDate = await f.api().post(`${url()}/shifts`).set(f.auth(main.token)).send({ ...body, date: undefined }).expect(422);
    expect(noDate.body.error.fields).toHaveProperty('date');
    await f.api().post(`${url()}/shifts`).set(f.auth(main.token)).send({ ...body, startMinutes: 1440 }).expect(422);
  });

  test('repeat: template with sorted days; days already taken at the same start are skipped', async () => {
    const d = await f.detachment(tenant);
    const existing = await f.shift(tenant, d, { date: '2030-06-05', startMinutes: 480, endMinutes: 840 });
    const res = await f
      .api()
      .post(`${url(d)}/shifts`)
      .set(f.auth(main.token))
      .send({ date: '2030-06-01', centerName: 'مركز الشعلان', startMinutes: 480, endMinutes: 840, needed: 3, repeatOn: ['2030-06-05', '2030-06-03', '2030-06-01'] })
      .expect(201);
    expect(res.body.date).toBe('2030-06-01');
    expect(res.body.templateId).toMatch(/^tpl_/);
    const tpl = await f.api().get(`/api/v1/shift-templates/${res.body.templateId}`).set(f.auth(main.token)).expect(200);
    expect(tpl.body).toMatchObject({ dates: ['2030-06-01', '2030-06-03', '2030-06-05'], active: true, startMinutes: 480, needed: 3 });
    const list = await f.api().get(`${url(d)}/shifts`).query({ from: '2030-06-01', to: '2030-06-07' }).set(f.auth(main.token)).expect(200);
    expect(list.body).toHaveLength(3);
    expect(list.body.find((s) => s.date === '2030-06-05').id).toBe(String(existing._id));
    expect(list.body.filter((s) => s.templateId === res.body.templateId).map((s) => s.date)).toEqual(['2030-06-01', '2030-06-03']);
  });

  test('capability: shift.manage in another detachment only → 403', async () => {
    const other = await f.detachment(tenant);
    const admin = await scoped(other, ['shift.manage']);
    const body = { date: '2030-05-12', centerName: 'مركز', startMinutes: 480, endMinutes: 840, needed: 2 };
    await f.api().post(`${url()}/shifts`).set(f.auth(admin.token)).send(body).expect(403);
    await f.api().post(`${url(other)}/shifts`).set(f.auth(admin.token)).send(body).expect(201);
  });

  test('Idempotency-Key replays the first response without a second shift', async () => {
    const d = await f.detachment(tenant);
    const key = f.idem();
    const body = { date: '2030-05-13', centerName: 'مركز', startMinutes: 480, endMinutes: 840, needed: 2 };
    const a = await f.api().post(`${url(d)}/shifts`).set(f.auth(main.token)).set(key).send(body).expect(201);
    const b = await f.api().post(`${url(d)}/shifts`).set(f.auth(main.token)).set(key).send(body).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(await f.models.Shift.countDocuments({ detachmentId: String(d._id) })).toBe(1);
  });
});

describe('update / delete', () => {
  test('PATCH recomputes the window; PUT validates; stale version → 409 stale_write', async () => {
    const s = await f.shift(tenant, det, { date: '2030-07-01' });
    const res = await f
      .api()
      .patch(`/api/v1/shifts/${s._id}`)
      .set(f.auth(main.token))
      .send({ date: '2030-07-02', startMinutes: 1320, endMinutes: 360, version: 1 })
      .expect(200);
    const w = shiftWindow('2030-07-02', 1320, 360, tz);
    expect(res.body).toMatchObject({ date: '2030-07-02', version: 2, crossesMidnight: true, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() });

    const eq = await f.api().put(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).send({ endMinutes: 1320 }).expect(422);
    expect(eq.body.error.fields).toHaveProperty('endMinutes');
    await f.api().put(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).send({ centerName: ' ' }).expect(422);
    await f.api().put(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).send({ needed: 0 }).expect(422);

    const stale = await f.api().put(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).send({ needed: 5, version: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_write', currentVersion: 2 });
    expect(stale.body.error.currentRecord.id).toBe(String(s._id));
    const ok = await f.api().put(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).send({ needed: 5, centerName: 'مركز جديد' }).expect(200);
    expect(ok.body).toMatchObject({ needed: 5, centerName: 'مركز جديد', version: 3 });
  });

  test('GET one shift; unknown → 404; other tenant → 404', async () => {
    const s = await f.shift(tenant, det, { date: '2030-07-03' });
    const res = await f.api().get(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).expect(200);
    expect(res.body.id).toBe(String(s._id));
    await f.api().get('/api/v1/shifts/sh_missing').set(f.auth(main.token)).expect(404);
    const other = await f.tenantWithMainAdmin();
    await f.api().get(`/api/v1/shifts/${s._id}`).set(f.auth(other.main.token)).expect(404);
  });

  test('DELETE needs shift.delete → 204', async () => {
    const s = await f.shift(tenant, det, { date: '2030-07-04' });
    const manager = await scoped(det, ['shift.manage']);
    await f.api().delete(`/api/v1/shifts/${s._id}`).set(f.auth(manager.token)).expect(403);
    await f.api().delete(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).expect(204);
    await f.api().get(`/api/v1/shifts/${s._id}`).set(f.auth(main.token)).expect(404);
  });
});

describe('templates', () => {
  const createRepeating = async (d, dates) => {
    const res = await f
      .api()
      .post(`${url(d)}/shifts`)
      .set(f.auth(main.token))
      .send({ date: dates[0], centerName: 'مركز الوعر', startMinutes: 480, endMinutes: 840, needed: 2, repeatOn: dates.slice(1) })
      .expect(201);
    return res.body;
  };

  test('PUT /shift-templates/:id/dates reconciles: materialize, delete empty, keep staffed', async () => {
    const d = await f.detachment(tenant);
    const m = await f.member(tenant, d);
    const anchor = await createRepeating(d, ['2030-08-03', '2030-08-04', '2030-08-05']);
    const staffed = await f.models.Shift.findOne({ templateId: anchor.templateId, date: '2030-08-05' });
    await f.api().post(`/api/v1/shifts/${staffed._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) }).expect(200);
    const empty = await f.models.Shift.findOne({ templateId: anchor.templateId, date: '2030-08-04' });

    const res = await f
      .api()
      .put(`/api/v1/shift-templates/${anchor.templateId}/dates`)
      .set(f.auth(main.token))
      .send({ dates: ['2030-08-03', '2030-08-06'] })
      .expect(200);
    expect(res.body.template).toMatchObject({ dates: ['2030-08-03', '2030-08-05', '2030-08-06'], active: true });
    expect(res.body.removed).toEqual([String(empty._id)]);
    expect(res.body.kept).toEqual([String(staffed._id)]);
    expect(res.body.created).toHaveLength(1);
    const shifts = await f.api().get(`/api/v1/shift-templates/${anchor.templateId}/shifts`).set(f.auth(main.token)).expect(200);
    expect(shifts.body.map((s) => s.date)).toEqual(['2030-08-03', '2030-08-05', '2030-08-06']);
    expect(shifts.body.find((s) => s.date === '2030-08-06').id).toBe(res.body.created[0]);

    // Down to the staffed day only → not a repeat any more; the anchor (empty) goes.
    const down = await f.api().put(`/api/v1/shift-templates/${anchor.templateId}/dates`).set(f.auth(main.token)).send({ dates: [] }).expect(200);
    expect(down.body.template).toMatchObject({ dates: ['2030-08-05'], active: false });
    expect(down.body.kept).toEqual([String(staffed._id)]);
    expect(down.body.removed).toHaveLength(2);
  });

  test('materialize skips a day+start taken by another shift', async () => {
    const d = await f.detachment(tenant);
    const anchor = await createRepeating(d, ['2030-09-07', '2030-09-08']);
    const blocker = await f.shift(tenant, d, { date: '2030-09-09', startMinutes: 480, endMinutes: 600 });
    const res = await f
      .api()
      .put(`/api/v1/shift-templates/${anchor.templateId}/dates`)
      .set(f.auth(main.token))
      .send({ dates: ['2030-09-07', '2030-09-08', '2030-09-09'] })
      .expect(200);
    expect(res.body.created).toEqual([]);
    expect(await f.models.Shift.countDocuments({ detachmentId: String(d._id), date: '2030-09-09' })).toBe(1);
    expect((await f.models.Shift.findById(blocker._id)).templateId).toBeNull();
  });

  test('PUT /shifts/:id/repeat creates a template for a standalone shift', async () => {
    const d = await f.detachment(tenant);
    const s = await f.shift(tenant, d, { date: '2030-10-05', centerName: 'مركز داريا' });
    const res = await f.api().put(`/api/v1/shifts/${s._id}/repeat`).set(f.auth(main.token)).send({ dates: ['2030-10-07', '2030-10-06'] }).expect(200);
    expect(res.body.template).toMatchObject({ dates: ['2030-10-05', '2030-10-06', '2030-10-07'], active: true, centerName: 'مركز داريا' });
    expect(res.body.shifts.map((x) => x.date)).toEqual(['2030-10-05', '2030-10-06', '2030-10-07']);
    expect(res.body.shifts.every((x) => x.templateId === res.body.template.id)).toBe(true);
    const again = await f.api().put(`/api/v1/shifts/${s._id}/repeat`).set(f.auth(main.token)).send({ dates: ['2030-10-06'] }).expect(200);
    expect(again.body.template.id).toBe(res.body.template.id);
    expect(again.body.shifts.map((x) => x.date)).toEqual(['2030-10-05', '2030-10-06']);
    await f.api().put(`/api/v1/shifts/${s._id}/repeat`).set(f.auth(main.token)).send({ dates: ['nope'] }).expect(422);
  });

  test('list (?active), get, stop; capabilities; foreign template → 404', async () => {
    const d = await f.detachment(tenant);
    const a = await createRepeating(d, ['2030-11-02', '2030-11-03']);
    const b = await createRepeating(d, ['2030-11-09', '2030-11-10']);
    const stop = await f.api().post(`/api/v1/shift-templates/${b.templateId}/stop`).set(f.auth(main.token)).expect(200);
    expect(stop.body.active).toBe(false);
    expect(await f.models.Shift.countDocuments({ templateId: b.templateId })).toBe(2);

    const active = await f.api().get(`${url(d)}/shift-templates`).query({ active: true }).set(f.auth(main.token)).expect(200);
    expect(active.body.map((t) => t.id)).toEqual([a.templateId]);
    const all = await f.api().get(`${url(d)}/shift-templates`).set(f.auth(main.token)).expect(200);
    expect(all.body.map((t) => t.id)).toEqual([a.templateId, b.templateId]);

    const viewer = await scoped(d, ['detachment.view']);
    await f.api().get(`/api/v1/shift-templates/${a.templateId}`).set(f.auth(viewer.token)).expect(200);
    await f.api().post(`/api/v1/shift-templates/${a.templateId}/stop`).set(f.auth(viewer.token)).expect(403);
    await f.api().put(`/api/v1/shift-templates/${a.templateId}/dates`).set(f.auth(viewer.token)).send({ dates: [] }).expect(403);
    await f.api().put(`/api/v1/shift-templates/${a.templateId}/dates`).set(f.auth(main.token)).send({ dates: '2030-11-02' }).expect(422);

    const other = await f.tenantWithMainAdmin();
    await f.api().get(`/api/v1/shift-templates/${a.templateId}`).set(f.auth(other.main.token)).expect(404);
  });
});

describe('copy', () => {
  test('copy-day copies without attendees/templateId and skips same-start duplicates', async () => {
    const d = await f.detachment(tenant);
    const m = await f.member(tenant, d);
    await f.shift(tenant, d, { date: '2030-12-01', startMinutes: 480, endMinutes: 840, attendees: [{ memberId: String(m._id) }], templateId: 'tpl_x' });
    await f.shift(tenant, d, { date: '2030-12-01', startMinutes: 1200, endMinutes: 120, needed: 5 });
    await f.shift(tenant, d, { date: '2030-12-08', startMinutes: 480, endMinutes: 600 });
    const res = await f.api().post(`${url(d)}/shifts/copy-day`).set(f.auth(main.token)).send({ fromDay: '2030-12-01', toDay: '2030-12-08' }).expect(200);
    expect(res.body).toEqual({ created: 1 });
    const copied = await f.models.Shift.findOne({ detachmentId: String(d._id), date: '2030-12-08', startMinutes: 1200 });
    expect(copied).toMatchObject({ needed: 5, endMinutes: 120, templateId: null });
    expect(copied.attendees).toHaveLength(0);
    const w = shiftWindow('2030-12-08', 1200, 120, tz);
    expect(copied.endsAt.toISOString()).toBe(w.endsAt.toISOString());

    const again = await f.api().post(`${url(d)}/shifts/copy-day`).set(f.auth(main.token)).send({ fromDay: '2030-12-01', toDay: '2030-12-08' }).expect(200);
    expect(again.body.created).toBe(0);
    const same = await f.api().post(`${url(d)}/shifts/copy-day`).set(f.auth(main.token)).send({ fromDay: '2030-12-01', toDay: '2030-12-01' }).expect(422);
    expect(same.body.error.code).toBe('validation');
  });

  test('copy-week maps each weekday onto the target week', async () => {
    const d = await f.detachment(tenant);
    // Week of Sat 2031-02-01: Saturday + Friday shifts.
    await f.shift(tenant, d, { date: '2031-02-01', startMinutes: 480, endMinutes: 840 });
    await f.shift(tenant, d, { date: '2031-02-07', startMinutes: 480, endMinutes: 840 });
    const res = await f
      .api()
      .post(`${url(d)}/shifts/copy-week`)
      .set(f.auth(main.token))
      .send({ fromWeekStart: '2031-02-04', toWeekStart: '2031-02-10' })
      .expect(200);
    expect(res.body.created).toBe(2);
    const target = await f.models.Shift.find({ detachmentId: String(d._id), date: { $gte: '2031-02-08', $lte: '2031-02-14' } }).sort({ date: 1 });
    expect(target.map((s) => s.date)).toEqual(['2031-02-08', '2031-02-14']);
    await f.api().post(`${url(d)}/shifts/copy-week`).set(f.auth(main.token)).send({ fromWeekStart: '2031-02-01', toWeekStart: '2031-02-06' }).expect(422);
    const viewer = await scoped(d, ['detachment.view']);
    await f.api().post(`${url(d)}/shifts/copy-week`).set(f.auth(viewer.token)).send({ fromWeekStart: '2031-02-01', toWeekStart: '2031-03-01' }).expect(403);
  });
});

describe('assignment', () => {
  test('assign → notCheckedIn attendee; the refusal ladder', async () => {
    const d = await f.detachment(tenant);
    const d2 = await f.detachment(tenant);
    const m = await f.member(tenant, d, { name: 'ليلى ياسين', role: 'shiftSupervisor' });
    const s = await f.shift(tenant, d, { date: '2031-03-01' });
    const res = await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) }).expect(200);
    expect(res.body.attendees).toHaveLength(1);
    expect(res.body.attendees[0]).toMatchObject({ id: String(m._id), name: 'ليلى ياسين', attendance: 'notCheckedIn', role: 'shiftSupervisor' });
    expect(res.body.attendees[0].phoneMasked).toBeDefined();

    await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({}).expect(422);
    const unknown = await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: 'm_nobody' }).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
    const foreignTenant = await f.createTenant();
    const fm = await f.member(foreignTenant, await f.detachment(foreignTenant));
    await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(fm._id) }).expect(404);
    const outsider = await f.member(tenant, d2);
    const other = await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(outsider._id) }).expect(422);
    expect(other.body.error.fields).toHaveProperty('memberId');
    const inactive = await f.member(tenant, d, { active: false });
    const ina = await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(inactive._id) }).expect(422);
    expect(ina.body.error.fields).toHaveProperty('memberId');
    const dup = await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) }).expect(409);
    expect(dup.body.error.code).toBe('conflict');
    expect(dup.body.error.reason).toBeUndefined();
  });

  test('overlap across midnight → 409 conflict reason overlap; back-to-back is fine', async () => {
    const d = await f.detachment(tenant);
    const m = await f.member(tenant, d);
    const night = await f.shift(tenant, d, { date: '2031-03-10', startMinutes: 1200, endMinutes: 120, attendees: [{ memberId: String(m._id) }] });
    const early = await f.shift(tenant, d, { date: '2031-03-11', startMinutes: 0, endMinutes: 360 });
    const res = await f.api().post(`/api/v1/shifts/${early._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'conflict', reason: 'overlap', overlapShiftId: String(night._id) });

    const after = await f.shift(tenant, d, { date: '2031-03-11', startMinutes: 120, endMinutes: 480 });
    await f.api().post(`/api/v1/shifts/${after._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) }).expect(200);
  });

  test('unassign → Shift; not assigned → 404; needs shift.assign', async () => {
    const d = await f.detachment(tenant);
    const m = await f.member(tenant, d);
    const s = await f.shift(tenant, d, { date: '2031-03-20', attendees: [{ memberId: String(m._id) }] });
    const manager = await scoped(d, ['shift.manage']);
    await f.api().delete(`/api/v1/shifts/${s._id}/assignments/${m._id}`).set(f.auth(manager.token)).expect(403);
    await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(manager.token)).send({ memberId: String(m._id) }).expect(403);
    const res = await f.api().delete(`/api/v1/shifts/${s._id}/assignments/${m._id}`).set(f.auth(main.token)).expect(200);
    expect(res.body.attendees).toEqual([]);
    await f.api().delete(`/api/v1/shifts/${s._id}/assignments/${m._id}`).set(f.auth(main.token)).expect(404);
  });

  test('candidates: free first, then role order, then name; busyWith for a clash', async () => {
    const d = await f.detachment(tenant);
    const d2 = await f.detachment(tenant);
    const s = await f.shift(tenant, d, { date: '2031-04-01', startMinutes: 480, endMinutes: 840 });
    const member = await f.member(tenant, d, { name: 'باسل', role: 'member' });
    const lead = await f.member(tenant, d, { name: 'زياد', role: 'shiftSupervisor' });
    const lead2 = await f.member(tenant, d, { name: 'أحمد', role: 'shiftSupervisor' });
    const busy = await f.member(tenant, d, { name: 'آدم', role: 'shiftSupervisor' });
    const onIt = await f.member(tenant, d, { name: 'سامر' });
    await f.member(tenant, d, { name: 'غائب', active: false });
    await f.member(tenant, d2, { name: 'بعيد' });
    await f.models.Shift.updateOne({ _id: s._id }, { $push: { attendees: { memberId: String(onIt._id) } } });
    const clash = await f.shift(tenant, d, { date: '2031-04-01', startMinutes: 600, endMinutes: 900, attendees: [{ memberId: String(busy._id) }] });

    const res = await f.api().get(`/api/v1/shifts/${s._id}/candidates`).set(f.auth(main.token)).expect(200);
    expect(res.body.map((c) => c.member.id)).toEqual([lead2, lead, member, busy].map((m) => String(m._id)));
    expect(res.body[0].busy).toBe(false);
    expect(res.body[0].busyWith).toBeUndefined();
    expect(res.body[3]).toMatchObject({
      busy: true,
      busyWith: { shiftId: String(clash._id), centerName: 'مركز الشعلان', date: '2031-04-01', startMinutes: 600, endMinutes: 900 },
    });
    const viewer = await scoped(d, ['detachment.view']);
    await f.api().get(`/api/v1/shifts/${s._id}/candidates`).set(f.auth(viewer.token)).expect(403);
  });

  test('concurrent assignments to one shift all land (lost races are re-applied)', async () => {
    const d = await f.detachment(tenant);
    const s = await f.shift(tenant, d, { date: '2031-04-03' });
    const ms = [];
    for (let i = 0; i < 3; i += 1) ms.push(await f.member(tenant, d));
    const results = await Promise.all(
      ms.map((m) => f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(f.auth(main.token)).send({ memberId: String(m._id) })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const stored = await f.models.Shift.findById(s._id);
    expect(stored.attendees.map((a) => a.memberId).sort()).toEqual(ms.map((m) => String(m._id)).sort());
  });

  test('quick-fill adds free candidates until the gap is closed', async () => {
    const d = await f.detachment(tenant);
    const s = await f.shift(tenant, d, { date: '2031-04-05', needed: 3 });
    const members = [];
    for (let i = 0; i < 4; i += 1) members.push(await f.member(tenant, d));
    await f.models.Shift.updateOne({ _id: s._id }, { $push: { attendees: { memberId: String(members[0]._id) } } });
    const busyShift = await f.shift(tenant, d, { date: '2031-04-05', startMinutes: 500, endMinutes: 700 });
    await f.models.Shift.updateOne({ _id: busyShift._id }, { $push: { attendees: { memberId: String(members[1]._id) } } });

    const res = await f.api().post(`/api/v1/shifts/${s._id}/quick-fill`).set(f.auth(main.token)).expect(200);
    expect(res.body.added).toBe(2);
    expect(res.body.shift.assigned).toBe(3);
    expect(res.body.shift.hasCoverageGap).toBe(false);
    expect(res.body.shift.attendees.map((a) => a.id)).not.toContain(String(members[1]._id));
    const again = await f.api().post(`/api/v1/shifts/${s._id}/quick-fill`).set(f.auth(main.token)).expect(200);
    expect(again.body.added).toBe(0);
  });
});
