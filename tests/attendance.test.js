/**
 * Shift attendance: the ordinary edit window (server time + settings grace),
 * check-in/out rules incl. the overnight normalization, the legacy
 * markAttendance, and append-only corrections (override only, valid forever).
 */
const { DateTime } = require('luxon');
const f = require('./helpers/factory');
const { todayIn, addDays } = require('../utils/time');

let tenant;
let main;
let det;
let tz;

const scoped = (keys) => f.simpleAdmin(tenant, { global: [], scoped: { [String(det._id)]: keys } });
const local = (day, hhmm) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: tz }).toJSDate().toISOString();

/** A shift with one assigned member. */
const staffed = async (overrides = {}) => {
  const m = await f.member(tenant, det);
  const s = await f.shift(tenant, det, { attendees: [{ memberId: String(m._id) }], ...overrides });
  return { s, m, base: `/api/v1/shifts/${s._id}/members/${m._id}` };
};

/** Today, 00:00–24:00: the window is open for the whole test run. */
const openShift = () => staffed({ date: todayIn(tz), startMinutes: 0, endMinutes: 1440 });

/** A shift of `duration` minutes that ended `minutesAgo` minutes ago (explicit date/minutes). */
const endedAgo = (minutesAgo, duration = 60) => {
  const endLocal = DateTime.now().setZone(tz).minus({ minutes: minutesAgo }).startOf('minute');
  const startLocal = endLocal.minus({ minutes: duration });
  return staffed({
    date: startLocal.toISODate(),
    startMinutes: startLocal.hour * 60 + startLocal.minute,
    endMinutes: endLocal.hour * 60 + endLocal.minute,
  });
};

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  tz = tenant.timezone || 'Asia/Damascus';
  det = await f.detachment(tenant);
  await f.setSettings({ attendanceGraceMinutes: 60 });
});

describe('ordinary path inside the window', () => {
  test('check-in (server now) → checkedIn; check-out → checkedOut', async () => {
    const { base } = await openShift();
    const before = Date.now();
    const a = await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({}).expect(200);
    const att = a.body.attendees[0];
    expect(att.attendance).toBe('checkedIn');
    expect(new Date(att.checkInAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(a.body.attendanceClosesAt).toBeDefined();
    const b = await f.api().post(`${base}/check-out`).set(f.auth(main.token)).send({}).expect(200);
    expect(b.body.attendees[0].attendance).toBe('checkedOut');
    expect(b.body.attendees[0].checkOutAt).toBeDefined();
  });

  test('check-out without check-in → 422 check_in_required', async () => {
    const { base } = await openShift();
    const res = await f.api().post(`${base}/check-out`).set(f.auth(main.token)).send({}).expect(422);
    expect(res.body.error.code).toBe('check_in_required');
  });

  test('explicit instants (no offset = tenant tz); check-in after check-out → 422; before → stays checkedOut', async () => {
    const { base } = await openShift();
    const today = todayIn(tz);
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: `${today}T09:00:00` }).expect(200);
    const out = await f.api().post(`${base}/check-out`).set(f.auth(main.token)).send({ at: `${today}T10:00:00.000` }).expect(200);
    expect(out.body.attendees[0].checkOutAt).toBe(local(today, '10:00'));
    const late = await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: `${today}T11:00:00` }).expect(422);
    expect(late.body.error.code).toBe('checkin_after_checkout');
    const fix = await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: `${today}T09:30:00` }).expect(200);
    expect(fix.body.attendees[0]).toMatchObject({ attendance: 'checkedOut', checkInAt: local(today, '09:30') });
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: 'not-a-time' }).expect(422);
  });

  test('check-out before check-in on a day shift → 422 checkout_before_checkin', async () => {
    const { base } = await openShift();
    const today = todayIn(tz);
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: `${today}T12:00:00` }).expect(200);
    const res = await f.api().post(`${base}/check-out`).set(f.auth(main.token)).send({ at: `${today}T11:00:00` }).expect(422);
    expect(res.body.error.code).toBe('checkout_before_checkin');
  });

  test('overnight: a check-out on the start day is read as the next morning', async () => {
    const today = todayIn(tz);
    const { base } = await staffed({ date: today, startMinutes: 1200, endMinutes: 120 });
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({ at: `${today}T20:30:00` }).expect(200);
    const res = await f.api().post(`${base}/check-out`).set(f.auth(main.token)).send({ at: `${today}T01:30:00` }).expect(200);
    expect(res.body.attendees[0]).toMatchObject({ attendance: 'checkedOut', checkOutAt: local(addDays(today, 1), '01:30') });
  });

  test('absent and reset clear both times', async () => {
    const { base } = await openShift();
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({}).expect(200);
    const abs = await f.api().post(`${base}/absent`).set(f.auth(main.token)).expect(200);
    expect(abs.body.attendees[0].attendance).toBe('absent');
    expect(abs.body.attendees[0].checkInAt).toBeUndefined();
    await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({}).expect(200);
    const rst = await f.api().post(`${base}/reset`).set(f.auth(main.token)).expect(200);
    expect(rst.body.attendees[0].attendance).toBe('notCheckedIn');
    expect(rst.body.attendees[0].checkInAt).toBeUndefined();
  });

  test('legacy PATCH /attendance accepts aliases and dispatches', async () => {
    const { base } = await openShift();
    const set = (attendance) => f.api().patch(`${base}/attendance`).set(f.auth(main.token)).send({ attendance });
    expect((await set('present').expect(200)).body.attendees[0].attendance).toBe('checkedIn');
    expect((await set('checkedOut').expect(200)).body.attendees[0].attendance).toBe('checkedOut');
    const reset = (await set('notInvited').expect(200)).body.attendees[0];
    expect(reset.attendance).toBe('notCheckedIn');
    expect(reset.checkInAt).toBeUndefined();
    expect((await set('late').expect(200)).body.attendees[0].attendance).toBe('checkedIn');
    expect((await set('absent').expect(200)).body.attendees[0].attendance).toBe('absent');
    const bad = await set('bogus').expect(422);
    expect(bad.body.error.fields).toHaveProperty('attendance');
    const { base: fresh } = await openShift();
    const noIn = await f.api().patch(`${fresh}/attendance`).set(f.auth(main.token)).send({ attendance: 'checkedOut' }).expect(422);
    expect(noIn.body.error.code).toBe('check_in_required');
  });

  test('member not on the shift → 404', async () => {
    const { s } = await openShift();
    const stranger = await f.member(tenant, det);
    await f.api().post(`/api/v1/shifts/${s._id}/members/${stranger._id}/check-in`).set(f.auth(main.token)).send({}).expect(404);
  });

  test('capabilities: record OR override inside the window; view only → 403', async () => {
    const { base } = await openShift();
    const recorder = await scoped(['shift.attendance.record']);
    const overrider = await scoped(['shift.attendance.override']);
    const viewer = await scoped(['detachment.view']);
    await f.api().post(`${base}/check-in`).set(f.auth(recorder.token)).send({}).expect(200);
    await f.api().post(`${base}/check-out`).set(f.auth(overrider.token)).send({}).expect(200);
    const r = await f.api().post(`${base}/reset`).set(f.auth(viewer.token)).expect(403);
    expect(r.body.error.code).toBe('not_permitted');
  });
});

describe('the window closes on server time', () => {
  test('a shift that ended days ago → 409 attendance_window_expired with closesAt', async () => {
    const { s, base } = await staffed({ date: addDays(todayIn(tz), -3) });
    const res = await f.api().post(`${base}/check-in`).set(f.auth(main.token)).send({}).expect(409);
    expect(res.body.error.code).toBe('attendance_window_expired');
    expect(res.body.error.closesAt).toBe(new Date(s.endsAt.getTime() + 60 * 60000).toISOString());
    for (const path of ['check-out', 'absent', 'reset']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await f.api().post(`${base}/${path}`).set(f.auth(main.token)).send({}).expect(409);
      expect(r.body.error.code).toBe('attendance_window_expired');
    }
    await f.api().patch(`${base}/attendance`).set(f.auth(main.token)).send({ attendance: 'absent' }).expect(409);
  });

  test('the grace comes from settings (ended 30 min ago: open at 60, closed at 20)', async () => {
    const { base } = await endedAgo(30);
    await f.api().post(`${base}/absent`).set(f.auth(main.token)).expect(200);
    await f.setSettings({ attendanceGraceMinutes: 20 });
    try {
      const res = await f.api().post(`${base}/reset`).set(f.auth(main.token)).expect(409);
      expect(res.body.error.code).toBe('attendance_window_expired');
      const shift = await f.api().get(base.replace(/\/members\/.*$/, '')).set(f.auth(main.token)).expect(200);
      expect(new Date(shift.body.attendanceClosesAt).getTime() - new Date(shift.body.endsAt).getTime()).toBe(20 * 60000);
    } finally {
      await f.setSettings({ attendanceGraceMinutes: 60 });
    }
  });

  test('a future shift is open', async () => {
    const { base } = await staffed({ date: addDays(todayIn(tz), 3) });
    await f.api().post(`${base}/absent`).set(f.auth(main.token)).expect(200);
  });
});

describe('corrections (append-only, override only, valid forever)', () => {
  test('after the window: override appends a correction and applies it', async () => {
    const day = addDays(todayIn(tz), -5);
    const { s, m, base } = await staffed({ date: day });
    const res = await f
      .api()
      .post(`${base}/attendance-corrections`)
      .set(f.auth(main.token))
      .send({ status: 'checkedOut', checkInAt: `${day}T08:05:00`, checkOutAt: `${day}T13:55:00`, reason: '  نسي   المشرف تسجيل الدخول ', correctedAt: '2020-01-01T00:00:00Z' })
      .expect(200);
    expect(res.body.attendees[0]).toMatchObject({ attendance: 'checkedOut', checkInAt: local(day, '08:05'), checkOutAt: local(day, '13:55') });
    expect(res.body.corrections).toHaveLength(1);
    const c = res.body.corrections[0];
    expect(c).toMatchObject({
      shiftId: String(s._id),
      memberId: String(m._id),
      before: { status: 'notCheckedIn' },
      after: { status: 'checkedOut', checkInAt: local(day, '08:05'), checkOutAt: local(day, '13:55') },
      reason: 'نسي المشرف تسجيل الدخول',
      author: { id: String(main.account._id), displayName: main.account.name },
      clientCorrectedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(c.id).toMatch(/^corr_/);
    expect(Math.abs(new Date(c.correctedAt).getTime() - Date.now())).toBeLessThan(60000);

    const second = await f
      .api()
      .post(`${base}/attendance-corrections`)
      .set(f.auth(main.token))
      .send({ status: 'absent', reason: 'تصحيح ثانٍ' })
      .expect(200);
    expect(second.body.corrections).toHaveLength(2);
    expect(second.body.corrections[1].before).toMatchObject({ status: 'checkedOut', checkInAt: local(day, '08:05') });
    expect(second.body.attendees[0].checkInAt).toBeUndefined();

    const list = await f.api().get(`/api/v1/shifts/${s._id}/attendance-corrections`).set(f.auth(main.token)).expect(200);
    expect(list.body.map((x) => x.id)).toEqual(second.body.corrections.map((x) => x.id));
  });

  test('overnight normalization applies to corrections; checkout before checkin → 422', async () => {
    const day = addDays(todayIn(tz), -4);
    const { base } = await staffed({ date: day, startMinutes: 1200, endMinutes: 120 });
    const ok = await f
      .api()
      .post(`${base}/attendance-corrections`)
      .set(f.auth(main.token))
      .send({ status: 'checkedOut', checkInAt: `${day}T20:10:00`, checkOutAt: `${day}T01:50:00`, reason: 'وردية ليلية' })
      .expect(200);
    expect(ok.body.corrections[0].after.checkOutAt).toBe(local(addDays(day, 1), '01:50'));

    const dayShift = await staffed({ date: day });
    const bad = await f
      .api()
      .post(`${dayShift.base}/attendance-corrections`)
      .set(f.auth(main.token))
      .send({ status: 'checkedOut', checkInAt: `${day}T13:00:00`, checkOutAt: `${day}T09:00:00`, reason: 'خطأ' })
      .expect(422);
    expect(bad.body.error.code).toBe('checkout_before_checkin');
    const unchanged = await f.models.Shift.findById(dayShift.s._id);
    expect(unchanged.corrections).toHaveLength(0);
  });

  test('blank reason → 422; bad status → 422; unknown member → 404', async () => {
    const day = addDays(todayIn(tz), -2);
    const { s, base } = await staffed({ date: day });
    const blank = await f.api().post(`${base}/attendance-corrections`).set(f.auth(main.token)).send({ status: 'absent', reason: '   ' }).expect(422);
    expect(blank.body.error.fields).toHaveProperty('reason');
    await f.api().post(`${base}/attendance-corrections`).set(f.auth(main.token)).send({ status: 'gone', reason: 'x' }).expect(422);
    await f.api().post(`/api/v1/shifts/${s._id}/members/m_nobody/attendance-corrections`).set(f.auth(main.token)).send({ status: 'absent', reason: 'x' }).expect(404);
  });

  test('record-only cannot correct; override-only can, after the window', async () => {
    const day = addDays(todayIn(tz), -6);
    const { base } = await staffed({ date: day });
    const recorder = await scoped(['shift.attendance.record']);
    const overrider = await scoped(['shift.attendance.override']);
    await f.api().post(`${base}/attendance-corrections`).set(f.auth(recorder.token)).send({ status: 'absent', reason: 'سبب' }).expect(403);
    await f.api().post(`${base}/check-in`).set(f.auth(recorder.token)).send({}).expect(409);
    await f.api().post(`${base}/check-in`).set(f.auth(overrider.token)).send({}).expect(409);
    await f.api().post(`${base}/attendance-corrections`).set(f.auth(overrider.token)).send({ status: 'absent', reason: 'سبب' }).expect(200);
  });

  test('no update or delete path exists for a correction', async () => {
    const { s, base } = await staffed({ date: addDays(todayIn(tz), -2) });
    const res = await f.api().post(`${base}/attendance-corrections`).set(f.auth(main.token)).send({ status: 'absent', reason: 'سبب' }).expect(200);
    const id = res.body.corrections[0].id;
    await f.api().patch(`/api/v1/shifts/${s._id}/attendance-corrections/${id}`).set(f.auth(main.token)).send({ reason: 'x' }).expect(404);
    await f.api().delete(`/api/v1/shifts/${s._id}/attendance-corrections/${id}`).set(f.auth(main.token)).expect(404);
  });
});
