/**
 * The restricted window of a new device (middlewares/restrictedSession) and
 * the trusted device's answers (GET/DELETE /auth/devices, approve, deny).
 */
const request = require('supertest');
const f = require('./helpers/factory');
const app = require('../app');
const config = require('../config');
const { uuidV7 } = require('../utils/ids');

const base = '/api/v1/auth';
const CODE = '246810';

const signIn = (email, device = f.DEVICE_ID) => f.api().post(`${base}/sign-in`).set(f.device(device)).send({ email, password: f.PASSWORD });
const verify = (challengeId, device) =>
  f.api().post(`${base}/verification/verify`).set(f.device(device)).set(f.idem()).send({ challengeId, code: CODE });
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));
const isRestricted = (res) => res.status === 403 && res.body.error && res.body.error.code === 'session_restricted';

/** A Main Admin with a trusted session and a session on a brand-new device. */
const twoDevices = async (accountOverrides = {}) => {
  const tenant = await f.createTenant();
  const { account } = await f.mainAdmin(tenant, accountOverrides);
  const trusted = (await signIn(account.email).expect(200)).body;
  const newDevice = f.newDeviceId();
  const ch = (await signIn(account.email, newDevice).expect(200)).body;
  const fresh = (await verify(ch.challenge.challengeId, newDevice).expect(200)).body;
  const deviceRef = (await f.models.Session.findById(fresh.sessionId)).deviceRef;
  return { tenant, account, trusted: trusted.accessToken, fresh: fresh.accessToken, newDevice, deviceRef };
};

describe('restricted session: account-level actions are refused', () => {
  test('password, MFA, other sessions, admins, organisation, billing, export, devices → 403 session_restricted', async () => {
    const { tenant, fresh, deviceRef } = await twoDevices();
    const ws = await f.workshop(tenant);
    const A = f.auth(fresh);
    const attempts = [
      f.api().post(`${base}/me/password`).set(A).send({ currentPassword: f.PASSWORD, newPassword: 'N3w-passw0rd!' }),
      f.api().post(`${base}/mfa/setup`).set(A),
      f.api().delete(`${base}/sessions`).set(A),
      f.api().post('/api/v1/tenant/simple-admin-invitations').set(A).set(f.idem()).send({ email: 'x@test.leader', grant: [] }),
      f.api().patch('/api/v1/settings/organization').set(A).set(f.idem()).send({ displayName: 'x' }),
      f.api().post('/api/v1/billing/checkout').set(A).set(f.idem()).send({}),
      f.api().get(`/api/v1/workshops/${ws._id}/export.csv`).set(A),
      f.api().post(`${base}/devices/${deviceRef}/approve`).set(A),
      f.api().delete(`${base}/devices/${deviceRef}`).set(A),
    ];
    for (const attempt of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const res = await attempt;
      expect(isRestricted(res)).toBe(true);
      expect(res.body.error.reason).toBe('new_device');
      expect(new Date(res.body.error.restrictedUntil).getTime()).toBeGreaterThan(Date.now());
    }
  });

  test('reads stay open, and the profile name may change', async () => {
    const { fresh } = await twoDevices();
    await f.api().get('/api/v1/detachments').set(f.auth(fresh)).expect(200);
    await f.api().get(`${base}/devices`).set(f.auth(fresh)).expect(200);
    await f.api().patch(`${base}/me`).set(f.auth(fresh)).send({ name: 'اسم جديد' }).expect(200);
  });
});

describe('restricted session: records', () => {
  test('older records cannot be edited or deleted; records this device creates can', async () => {
    const { tenant, fresh } = await twoDevices();
    const A = f.auth(fresh);
    const old = await f.group(tenant);
    expect(isRestricted(await f.api().patch(`/api/v1/detachment-groups/${old._id}`).set(A).send({ notes: 'x' }))).toBe(true);
    expect(isRestricted(await f.api().delete(`/api/v1/detachment-groups/${old._id}`).set(A))).toBe(true);

    const created = await f.api().post('/api/v1/detachment-groups').set(A).set(f.idem()).send({ name: `مجموعة ${f.uniq()}` }).expect(201);
    const own = await f.models.DetachmentGroup.findById(created.body.id).select('+_createdByDevice');
    expect(own._createdByDevice).toBeTruthy();
    expect(created.body._createdByDevice).toBeUndefined();
    await f.api().patch(`/api/v1/detachment-groups/${created.body.id}`).set(A).send({ notes: 'ملاحظة' }).expect(200);
  });

  test('field work on older records is allowed (Q5); core edits, unassign and payment stay blocked', async () => {
    const { tenant, fresh } = await twoDevices();
    const A = f.auth(fresh);
    const det = await f.detachment(tenant);
    const m = await f.member(tenant, det);
    const s = await f.shift(tenant, det);
    const item = await f.inventoryItem(tenant, det);

    await f.api().post(`/api/v1/shifts/${s._id}/assignments`).set(A).send({ memberId: String(m._id) }).expect(200);
    const checkIn = await f.api().post(`/api/v1/shifts/${s._id}/members/${m._id}/check-in`).set(A).send({});
    expect(isRestricted(checkIn)).toBe(false);
    const absent = await f.api().post(`/api/v1/shifts/${s._id}/members/${m._id}/absent`).set(A).send({});
    expect(isRestricted(absent)).toBe(false);
    const movement = await f.api()
      .post(`/api/v1/inventory-items/${item._id}/movements`)
      .set(A)
      .send({ direction: 'outflow', quantity: 1, reason: 'مناوبة' });
    expect(isRestricted(movement)).toBe(false);

    expect(isRestricted(await f.api().delete(`/api/v1/shifts/${s._id}/assignments/${m._id}`).set(A))).toBe(true);
    expect(isRestricted(await f.api().post(`/api/v1/shifts/${s._id}/members/${m._id}/reset`).set(A))).toBe(true);
    expect(isRestricted(await f.api().patch(`/api/v1/shifts/${s._id}/members/${m._id}/attendance`).set(A).send({ status: 'present' }))).toBe(true);
    expect(isRestricted(await f.api().patch(`/api/v1/members/${m._id}`).set(A).send({ name: 'x' }))).toBe(true);
    expect(isRestricted(await f.api().patch(`/api/v1/inventory-items/${item._id}`).set(A).send({ name: 'x' }))).toBe(true);

    const ws = await f.workshop(tenant);
    const participant = await f.models.WorkshopParticipant.create({ tenantId: String(tenant._id), workshopId: String(ws._id), kind: 'guest', name: 'ضيف' });
    expect(isRestricted(await f.api().patch(`/api/v1/workshop-participants/${participant._id}/payment`).set(A).send({ paid: true }))).toBe(true);
  });

  test('sync push replays each operation under the same restriction', async () => {
    const { tenant, fresh } = await twoDevices();
    const det = await f.detachment(tenant);
    const m = await f.member(tenant, det);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await request(server)
        .post('/api/v1/sync/push')
        .set(f.auth(fresh))
        .send({ operations: [{ operationId: uuidV7(), kind: 'member.update', payload: { memberId: String(m._id), name: 'x' } }] });
      const [result] = res.body.results;
      expect(result.httpStatus).toBe(403);
      expect(result.code).toBe('session_restricted');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the trusted device answers', () => {
  test('Yes lifts the restriction at once and clears the notice', async () => {
    const { tenant, trusted, fresh, deviceRef } = await twoDevices();
    const pending = (await me(trusted).expect(200)).body.access.pendingDeviceApprovals;
    expect(pending.map((d) => d.id)).toEqual([deviceRef]);
    await f.api().post(`${base}/devices/${deviceRef}/approve`).set(f.auth(trusted)).expect(204);

    expect((await me(fresh).expect(200)).body.access.deviceRestriction).toBeUndefined();
    expect((await me(trusted).expect(200)).body.access.pendingDeviceApprovals).toBeUndefined();
    const old = await f.group(tenant);
    await f.api().patch(`/api/v1/detachment-groups/${old._id}`).set(f.auth(fresh)).send({ notes: 'x' }).expect(200);
  });

  test('only a trusted, unrestricted device may answer', async () => {
    const { account, fresh, deviceRef } = await twoDevices();
    const { token: unbound } = await f.login(account);
    const res = await f.api().post(`${base}/devices/${deviceRef}/approve`).set(f.auth(unbound)).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    expect(isRestricted(await f.api().post(`${base}/devices/${deviceRef}/deny`).set(f.auth(fresh)))).toBe(true);
  });

  test('No (Main Admin, password): device blocked, every session ends, password reset required, Super Admins told', async () => {
    const supers = await f.superAdmin();
    const { account, trusted, fresh, newDevice, deviceRef } = await twoDevices();
    const res = await f.api().post(`${base}/devices/${deviceRef}/deny`).set(f.auth(trusted)).expect(200);
    expect(res.body).toEqual({ passwordReset: true });

    await me(trusted).expect(401);
    await me(fresh).expect(401);
    expect((await f.models.Device.findById(deviceRef)).status).toBe('blocked');
    expect((await signIn(account.email, newDevice).expect(403)).body.error.code).toBe('device_blocked');
    expect((await signIn(account.email).expect(403)).body.error.code).toBe('password_reset_required');
    expect(await f.models.DevMail.countDocuments({ to: supers.account.email, kind: 'deviceDeniedAlert' })).toBe(1);
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'new_device_denied', accountId: String(account._id) })).toBe(1);

    const alerts = (await f.api().get('/api/v1/platform/security-alerts').set(f.auth(supers.token)).expect(200)).body;
    const list = Array.isArray(alerts) ? alerts : alerts.alerts;
    expect(list.some((a) => a.id.startsWith('security_device_denied_'))).toBe(true);
  });

  test('No (Simple Admin): the team’s Main Admin is emailed', async () => {
    const tenant = await f.createTenant();
    const { account: main } = await f.mainAdmin(tenant);
    const { account } = await f.simpleAdmin(tenant);
    const trusted = (await signIn(account.email).expect(200)).body.accessToken;
    const newDevice = f.newDeviceId();
    const ch = (await signIn(account.email, newDevice).expect(200)).body;
    const fresh = (await verify(ch.challenge.challengeId, newDevice).expect(200)).body;
    const { deviceRef } = await f.models.Session.findById(fresh.sessionId);
    await f.api().post(`${base}/devices/${deviceRef}/deny`).set(f.auth(trusted)).expect(200);
    expect(await f.models.DevMail.countDocuments({ to: main.email, kind: 'deviceDeniedAlert' })).toBe(1);
  });

  test('No on a Google-only account: no password reset', async () => {
    const email = `${f.uniq('gonly')}@test.leader`;
    const account = await f.createAccount({ email, role: 'super_admin', setupCompleted: true, googleSub: `mock:${email}` });
    await f.models.Account.updateOne({ _id: account._id }, { $set: { methods: ['google'] }, $unset: { passwordHash: '' } });
    const google = (device) => f.api().post(`${base}/google`).set(f.device(device)).set(f.idem()).send({ idToken: `mock-google:${email}` });
    const trusted = (await google(f.DEVICE_ID).expect(200)).body.accessToken;
    const newDevice = f.newDeviceId();
    const ch = (await google(newDevice).expect(200)).body;
    const fresh = (await verify(ch.challenge.challengeId, newDevice).expect(200)).body;
    const { deviceRef } = await f.models.Session.findById(fresh.sessionId);
    const res = await f.api().post(`${base}/devices/${deviceRef}/deny`).set(f.auth(trusted)).expect(200);
    expect(res.body).toEqual({ passwordReset: false });
    expect((await f.models.Account.findById(account._id)).passwordResetRequired).toBe(false);
  });

  test('a password reset clears the requirement', async () => {
    const { account, trusted, deviceRef } = await twoDevices();
    await f.api().post(`${base}/devices/${deviceRef}/deny`).set(f.auth(trusted)).expect(200);
    const req = await f.api().post(`${base}/password-reset/request`).send({ email: account.email }).expect(200);
    const bearer = { Authorization: `Bearer ${req.body.resetToken}` };
    await f.api().post(`${base}/password-reset/verify`).set(bearer).send({ email: account.email, code: CODE }).expect(204);
    await f.api().post(`${base}/password-reset/complete`).set(bearer).send({ password: 'Br4nd-new-pass' }).expect(204);
    const ok = await f.api().post(`${base}/sign-in`).set(f.device()).send({ email: account.email, password: 'Br4nd-new-pass' }).expect(200);
    expect(ok.body.outcome).toBe('ready');
  });
});

describe('My devices', () => {
  test('GET /auth/devices lists trusted and untrusted devices, never blocked ones', async () => {
    const { account, trusted, deviceRef } = await twoDevices();
    await f.trustDevice(account, f.newDeviceId(), { status: 'blocked' });
    const res = await f.api().get(`${base}/devices`).set(f.auth(trusted)).expect(200);
    expect(res.body.limit).toBe(config.trustedDevicesMax);
    expect(res.body.devices).toHaveLength(2);
    const fresh = res.body.devices.find((d) => d.id === deviceRef);
    expect(fresh).toMatchObject({ status: 'trusted', current: false, restricted: true });
    expect(Object.keys(fresh).sort()).toEqual(['current', 'id', 'label', 'lastSeenAt', 'restricted', 'restrictedUntil', 'signedInAt', 'status']);
    expect(res.body.devices.find((d) => d.current)).toBeTruthy();
  });

  test('removing a device ends its sessions; it needs the code again; the current device cannot be removed', async () => {
    const { account, trusted, fresh, newDevice, deviceRef } = await twoDevices();
    await f.api().delete(`${base}/devices/${deviceRef}`).set(f.auth(trusted)).expect(204);
    await me(fresh).expect(401);
    expect((await signIn(account.email, newDevice).expect(200)).body.challenge.purpose).toBe('new_device');

    const current = (await f.api().get(`${base}/devices`).set(f.auth(trusted)).expect(200)).body.devices.find((d) => d.current);
    const self = await f.api().delete(`${base}/devices/${current.id}`).set(f.auth(trusted)).expect(422);
    expect(self.body.error.code).toBe('validation');
  });

  test('an untrusted 4th device: Yes is refused while full (409), accepted once a slot is freed', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant);
    const spare = await f.trustDevice(account, f.newDeviceId());
    await f.trustDevice(account, f.newDeviceId());
    const trusted = (await signIn(account.email).expect(200)).body.accessToken;
    const fourth = f.newDeviceId();
    const ch = (await signIn(account.email, fourth).expect(200)).body;
    const fresh = (await verify(ch.challenge.challengeId, fourth).expect(200)).body;
    const { deviceRef } = await f.models.Session.findById(fresh.sessionId);

    const full = await f.api().post(`${base}/devices/${deviceRef}/approve`).set(f.auth(trusted)).expect(409);
    expect(full.body.error.code).toBe('trusted_device_limit');
    await f.api().delete(`${base}/devices/${spare._id}`).set(f.auth(trusted)).expect(204);
    await f.api().post(`${base}/devices/${deviceRef}/approve`).set(f.auth(trusted)).expect(204);
    expect((await f.models.Device.findById(deviceRef)).status).toBe('trusted');
    expect((await me(fresh.accessToken).expect(200)).body.access.deviceRestriction).toBeUndefined();
  });
});
