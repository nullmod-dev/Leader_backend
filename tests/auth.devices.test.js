/**
 * Device trust at sign-in (services/deviceService.admit):
 * X-Device-Id on every sign-in, the first-device code, the new-device code
 * and its restricted window, the trusted-device limit, blocked devices, the
 * returning-Google rule and sessions that predate device trust.
 */
const f = require('./helpers/factory');
const config = require('../config');

const base = '/api/v1/auth';
const CODE = '246810';
const addr = (p = 'dv') => `${f.uniq(p)}@test.leader`;

const signIn = (email, device = f.DEVICE_ID, password = f.PASSWORD) =>
  f.api().post(`${base}/sign-in`).set(f.device(device)).send({ email, password });
const verify = (challengeId, device = f.DEVICE_ID) =>
  f.api().post(`${base}/verification/verify`).set(f.device(device)).set(f.idem()).send({ challengeId, code: CODE });
const google = (email, device = f.DEVICE_ID) =>
  f.api().post(`${base}/google`).set(f.device(device)).set(f.idem()).send({ idToken: `mock-google:${email}` });
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));

/** Sign in on `device`, answering the email code when one is asked. */
const signInWithCode = async (email, device) => {
  const first = await signIn(email, device).expect(200);
  expect(first.body.outcome).toBe('verification_required');
  expect(first.body.challenge.purpose).toBe('new_device');
  const done = await verify(first.body.challenge.challengeId, device).expect(200);
  return done.body;
};

const finishedAdmin = async (overrides = {}) => {
  const tenant = await f.createTenant();
  const { account } = await f.mainAdmin(tenant, overrides);
  return { tenant, account };
};

const mailsTo = (to, kind) => f.models.DevMail.countDocuments({ to, kind });

describe('X-Device-Id', () => {
  test('a sign-in without a valid X-Device-Id → 400 device_id_required', async () => {
    const { account } = await finishedAdmin();
    const none = await f.api().post(`${base}/sign-in`).send({ email: account.email, password: f.PASSWORD }).expect(400);
    expect(none.body.error.code).toBe('device_id_required');
    const bad = await f.api()
      .post(`${base}/sign-in`)
      .set('X-Device-Id', 'not-a-uuid')
      .send({ email: account.email, password: f.PASSWORD })
      .expect(400);
    expect(bad.body.error.code).toBe('device_id_required');
  });

  test('only a hash of the id is stored', async () => {
    const email = addr('hash');
    await f.createAccount({ email, trustedDevice: false });
    const device = f.newDeviceId();
    await signInWithCode(email, device);
    const raw = JSON.stringify(await f.models.Device.find({}).lean());
    expect(raw).not.toContain(device);
  });
});

describe('first device (Q1)', () => {
  test('an account with no device record: email code, then trusted with no restriction and no notice', async () => {
    const email = addr('first');
    await f.createAccount({ email, role: 'super_admin', setupCompleted: true, trustedDevice: false });
    const device = f.newDeviceId();
    const ready = await signInWithCode(email, device);
    expect(ready.outcome).toBe('ready');
    const access = (await me(ready.accessToken).expect(200)).body.access;
    expect(access.deviceRestriction).toBeUndefined();
    const [record] = await f.models.Device.find({ accountId: String((await f.models.Account.findOne({ email }))._id) });
    expect(record).toMatchObject({ status: 'trusted', noticePending: false });
    expect(await mailsTo(email, 'newDeviceSignedIn')).toBe(0);
    // Next time on the same device: no code.
    const again = await signIn(email, device).expect(200);
    expect(again.body.outcome).toBe('ready');
  });

  test('sign-up: the email code is the first-device code (no second code, no restriction)', async () => {
    const email = addr('signup');
    const ch = await f.api().post(`${base}/sign-up`).set(f.idem()).send({ email, password: 'Str0ng-passw0rd' }).expect(202);
    const done = await verify(ch.body.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
    const account = await f.models.Account.findOne({ email });
    expect(await f.models.Device.countDocuments({ accountId: String(account._id), status: 'trusted' })).toBe(1);
  });
});

describe('new device on an account that has a trusted device', () => {
  test('password: code, then a session restricted for NEW_DEVICE_RESTRICT_HOURS; the account is told', async () => {
    const { account } = await finishedAdmin();
    const device = f.newDeviceId();
    const before = Date.now();
    const ready = await signInWithCode(account.email, device);
    expect(ready.outcome).toBe('ready');

    const access = (await me(ready.accessToken).expect(200)).body.access;
    expect(access.deviceRestriction.reason).toBe('new_device');
    const until = new Date(access.deviceRestriction.until).getTime();
    expect(until).toBeGreaterThanOrEqual(before + config.newDeviceRestrictHours * 3600000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + config.newDeviceRestrictHours * 3600000 + 1000);
    expect(await mailsTo(account.email, 'newDeviceSignedIn')).toBe(1);

    // The trusted device sees the notice; the new device never sees its own.
    const trusted = await signIn(account.email).expect(200);
    const pending = (await me(trusted.body.accessToken).expect(200)).body.access.pendingDeviceApprovals;
    expect(pending).toHaveLength(1);
    expect(Object.keys(pending[0]).sort()).toEqual(['id', 'label', 'signedInAt']);
    expect(access.pendingDeviceApprovals).toBeUndefined();

    // The window is the device's: signing in again on it stays restricted, with no code.
    const again = await signIn(account.email, device).expect(200);
    expect(again.body.outcome).toBe('ready');
    expect((await me(again.body.accessToken).expect(200)).body.access.deviceRestriction.reason).toBe('new_device');
  });

  test('the restriction lifts by itself when the window ends', async () => {
    const { account } = await finishedAdmin();
    const device = f.newDeviceId();
    const ready = await signInWithCode(account.email, device);
    const session = await f.models.Session.findById(ready.sessionId);
    await f.models.Device.updateOne({ _id: session.deviceRef }, { $set: { restrictedUntil: new Date(Date.now() - 1000) } });
    const access = (await me(ready.accessToken).expect(200)).body.access;
    expect(access.deviceRestriction).toBeUndefined();
  });

  test('a returning Google account on a new device: the sign-in code doubles as the device code', async () => {
    const email = addr('gnew');
    await f.createAccount({ email, role: 'super_admin', setupCompleted: true, googleSub: `mock:${email}` });
    const device = f.newDeviceId();
    const first = await google(email, device).expect(200);
    expect(first.body.challenge.purpose).toBe('sign_in');
    const done = await verify(first.body.challenge.challengeId, device).expect(200);
    expect(done.body.outcome).toBe('ready');
    expect((await me(done.body.accessToken).expect(200)).body.access.deviceRestriction.reason).toBe('new_device');
  });

  test('a returning Google account linking a NEW Google identity needs the code even on a trusted device', async () => {
    const email = addr('glink');
    await f.createAccount({ email, role: 'super_admin', setupCompleted: true });
    const res = await google(email).expect(200);
    expect(res.body.challenge.purpose).toBe('sign_in');
  });
});

describe('trusted-device limit (Q2)', () => {
  test('a 4th device signs in with the code, stays untrusted and restricted, and needs the code every time', async () => {
    const { account } = await finishedAdmin();
    await f.trustDevice(account, f.newDeviceId());
    await f.trustDevice(account, f.newDeviceId());
    expect(await f.models.Device.countDocuments({ accountId: String(account._id), status: 'trusted' })).toBe(config.trustedDevicesMax);

    const fourth = f.newDeviceId();
    const ready = await signInWithCode(account.email, fourth);
    const access = (await me(ready.accessToken).expect(200)).body.access;
    expect(access.deviceRestriction).toEqual({ reason: 'device_limit' });
    const session = await f.models.Session.findById(ready.sessionId);
    expect((await f.models.Device.findById(session.deviceRef)).status).toBe('untrusted');

    const again = await signIn(account.email, fourth).expect(200);
    expect(again.body.challenge.purpose).toBe('new_device');
  });
});

describe('blocked device', () => {
  test('password, Google and a session on a blocked device are refused', async () => {
    const email = addr('blk');
    const account = await f.createAccount({ email, role: 'super_admin', setupCompleted: true, googleSub: `mock:${email}` });
    const device = f.newDeviceId();
    await f.trustDevice(account, device, { status: 'blocked', blockedAt: new Date() });
    const pw = await signIn(email, device).expect(403);
    expect(pw.body.error.code).toBe('device_blocked');
    const g = await google(email, device).expect(403);
    expect(g.body.error.code).toBe('device_blocked');
  });
});

describe('sessions that predate device trust', () => {
  test('the first request carrying X-Device-Id registers that phone as trusted, with no code', async () => {
    const { account } = await finishedAdmin();
    const { token, session } = await f.login(account);
    const device = f.newDeviceId();
    const res = await me(token).set(f.device(device)).expect(200);
    expect(res.body.access.deviceRestriction).toBeUndefined();
    const bound = await f.models.Session.findById(session._id);
    const record = await f.models.Device.findById(bound.deviceRef);
    expect(record).toMatchObject({ status: 'trusted', legacy: true });
    // That phone now signs in with no code.
    expect((await signIn(account.email, device).expect(200)).body.outcome).toBe('ready');
  });

  test('no free slot → untrusted and restricted; a blocked device ends the session', async () => {
    const { account } = await finishedAdmin();
    await f.trustDevice(account, f.newDeviceId());
    await f.trustDevice(account, f.newDeviceId());
    const { token } = await f.login(account);
    const res = await me(token).set(f.device(f.newDeviceId())).expect(200);
    expect(res.body.access.deviceRestriction).toEqual({ reason: 'device_limit' });

    const blocked = f.newDeviceId();
    await f.trustDevice(account, blocked, { status: 'blocked' });
    const { token: other } = await f.login(account);
    const ended = await me(other).set(f.device(blocked)).expect(401);
    expect(ended.body.error.code).toBe('authentication_expired');
  });

  test('a request without X-Device-Id leaves the session unbound and unrestricted', async () => {
    const { account } = await finishedAdmin();
    const { token, session } = await f.login(account);
    const res = await me(token).expect(200);
    expect(res.body.access.deviceRestriction).toBeUndefined();
    expect((await f.models.Session.findById(session._id)).deviceRef).toBeUndefined();
  });
});
