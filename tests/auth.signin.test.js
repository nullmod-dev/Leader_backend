/**
 * /auth/sign-in, /auth/refresh, /auth/sign-out, /auth/google.
 */
const f = require('./helpers/factory');
const authorizationService = require('../services/authorizationService');

const base = '/api/v1/auth';
const CODE = '246810';
const PW = 'Str0ng-passw0rd';

const signIn = (email, password = f.PASSWORD) => f.api().post(`${base}/sign-in`).send({ email, password });
const signUp = (email, password = PW) => f.api().post(`${base}/sign-up`).set(f.idem()).send({ email, password });
const verify = (challengeId, code = CODE) => f.api().post(`${base}/verification/verify`).set(f.idem()).send({ challengeId, code });
const google = (idToken) => f.api().post(`${base}/google`).set(f.idem()).send({ idToken });
const refresh = (refreshToken) => f.api().post(`${base}/refresh`).send({ refreshToken });
const addr = (p = 'si') => `${f.uniq(p)}@test.leader`;
const sidOf = (accessToken) => JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sid;

describe('POST /auth/sign-in', () => {
  test('finished administrator → ready with a full session', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant);
    const res = await signIn(account.email.toUpperCase()).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'outcome', 'refreshToken', 'sessionId']);
    expect(res.body.outcome).toBe('ready');
    expect(res.body.sessionId).toBe(sidOf(res.body.accessToken));
    const me = await f.api().get(`${base}/me`).set(f.auth(res.body.accessToken)).expect(200);
    expect(me.body.sessionId).toBe(res.body.sessionId);
    expect(me.body.user).toMatchObject({ id: String(account._id), role: 'main_admin', saasTenantId: String(tenant._id) });
    expect((await f.models.Account.findById(account._id)).lastLoginAt).toBeInstanceOf(Date);
  });

  test('super_admin → ready', async () => {
    const { account } = await f.superAdmin();
    const res = await signIn(account.email).expect(200);
    expect(res.body.outcome).toBe('ready');
  });

  test('wrong password vs unknown address vs no password method: identical 401 invalid_credentials', async () => {
    const known = await f.createAccount({ email: addr('known') });
    const googleOnly = await f.createAccount({ email: addr('g') });
    await f.models.Account.updateOne({ _id: googleOnly._id }, { $set: { methods: ['google'] }, $unset: { passwordHash: '' } });

    const wrong = await signIn(known.email, 'not-the-password').expect(401);
    const unknown = await signIn(addr('nobody'), 'not-the-password').expect(401);
    const noPassword = await signIn(googleOnly.email, f.PASSWORD).expect(401);
    const strip = (b) => ({ ...b.error, reference: undefined });
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect(strip(noPassword.body)).toEqual(strip(unknown.body));
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'sign_in_failed' })).toBeGreaterThanOrEqual(3);
  });

  test('customer_demo accounts cannot sign in', async () => {
    const demo = await f.createAccount({ email: addr('demo'), role: 'customer_demo', setupCompleted: true });
    const res = await signIn(demo.email).expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  test('unverified account → verification_required with a new challenge (older ones ended)', async () => {
    const email = addr('unv');
    const first = await signUp(email).expect(202);
    const res = await signIn(email, PW).expect(200);
    expect(res.body.outcome).toBe('verification_required');
    expect(res.body.challenge.challengeId).not.toBe(first.body.challengeId);
    expect((await f.models.VerificationChallenge.findById(first.body.challengeId)).status).toBe('ended');
    const done = await verify(res.body.challenge.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
  });

  test('verified but unfinished account → onboarding outcome with snapshot', async () => {
    const account = await f.createAccount({ email: addr('onb'), status: 'pending_setup', name: 'سارة' });
    const res = await signIn(account.email).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    expect(res.body.snapshot).toMatchObject({
      accountId: String(account._id),
      linkStatus: 'unlinked',
      setupStatus: 'required',
      displayNameSuggestion: 'سارة',
    });
    const session = await f.models.Session.findOne({ accountId: String(account._id) });
    expect(session.scope).toBe('onboarding');
  });

  test('suspended FINISHED account still gets a full session; /me reports the status', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant, { status: 'suspended' });
    const res = await signIn(account.email).expect(200);
    expect(res.body.outcome).toBe('ready');
    const me = await f.api().get(`${base}/me`).set(f.auth(res.body.accessToken)).expect(200);
    expect(me.body.access.accountStatus).toBe('suspended');
    // The account's own MFA setup requires an active account.
    const mfa = await f.api().post(`${base}/mfa/setup`).set(f.auth(res.body.accessToken)).expect(403);
    expect(mfa.body.error.code).toBe('account_unavailable');
    // /auth/sessions uses accountGuard (session + MFA only) → still readable.
    await f.api().get(`${base}/sessions`).set(f.auth(res.body.accessToken)).expect(200);
  });

  test('throttle: after 5 failures → 429 rate_limited with retryAfterSeconds (even with the right password)', async () => {
    const account = await f.createAccount({ email: addr('lock') });
    for (let i = 0; i < 5; i += 1) await signIn(account.email, 'wrong-password').expect(401);
    const res = await signIn(account.email).expect(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('lockout budget comes from settings', async () => {
    await f.setSettings({ 'signInLockout.maxFailures': 2 });
    try {
      const email = addr('lock2');
      await signIn(email, 'x').expect(401);
      await signIn(email, 'x').expect(401);
      await signIn(email, 'x').expect(429);
    } finally {
      await f.setSettings({ 'signInLockout.maxFailures': 5 });
    }
  });

  test('missing fields → 422 validation', async () => {
    const res = await f.api().post(`${base}/sign-in`).send({ email: 'a@b.co' }).expect(422);
    expect(res.body.error.fields.password).toBeDefined();
  });
});

describe('refresh rotation + replay', () => {
  test('rotation issues a new pair; replaying a rotated token revokes the whole family', async () => {
    const account = await f.createAccount({ email: addr('rot'), role: 'super_admin', setupCompleted: true });
    const { body: s } = await signIn(account.email).expect(200);

    const r1 = await refresh(s.refreshToken).expect(200);
    expect(Object.keys(r1.body).sort()).toEqual(['accessToken', 'refreshToken', 'sessionId']);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    // Rotation keeps the session: same stable id, same JWT sid.
    expect(r1.body.sessionId).toBe(s.sessionId);
    expect(sidOf(r1.body.accessToken)).toBe(s.sessionId);
    await f.api().get(`${base}/me`).set(f.auth(r1.body.accessToken)).expect(200);

    const replay = await refresh(s.refreshToken).expect(401);
    expect(replay.body.error.code).toBe('authentication_expired');
    // The family is gone: the latest refresh token and the access token die too.
    await refresh(r1.body.refreshToken).expect(401);
    const me = await f.api().get(`${base}/me`).set(f.auth(r1.body.accessToken)).expect(401);
    expect(me.body.error.code).toBe('authentication_expired');
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'refresh_replay', accountId: String(account._id) })).toBe(1);
  });

  test('every failure is 401 authentication_expired', async () => {
    for (const body of [{}, { refreshToken: 'nope' }, { refreshToken: 42 }]) {
      const res = await f.api().post(`${base}/refresh`).send(body).expect(401);
      expect(res.body.error.code).toBe('authentication_expired');
    }
  });
});

describe('POST /auth/sign-out', () => {
  test('full session → 204, token and refresh dead', async () => {
    const account = await f.createAccount({ email: addr('out'), role: 'super_admin', setupCompleted: true });
    const { body: s } = await signIn(account.email).expect(200);
    await f.api().post(`${base}/sign-out`).set(f.auth(s.accessToken)).expect(204);
    await f.api().get(`${base}/me`).set(f.auth(s.accessToken)).expect(401);
    await refresh(s.refreshToken).expect(401);
  });

  test('onboarding session can sign out; no bearer → 401', async () => {
    const account = await f.createAccount({ email: addr('out2'), status: 'pending_setup' });
    const { body } = await signIn(account.email).expect(200);
    await f.api().post(`${base}/sign-out`).set(f.auth(body.onboardingToken)).expect(204);
    await f.api().get(`${base}/onboarding`).set(f.auth(body.onboardingToken)).expect(401);
    const res = await f.api().post(`${base}/sign-out`).expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });
});

describe('POST /auth/google (mock assertions)', () => {
  test('new verified identity → account created (methods [google]) → onboarding', async () => {
    const email = addr('gnew');
    const res = await google(`mock-google:${email}`).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    expect(res.body.snapshot.methods).toEqual(['google']);
    const account = await f.models.Account.findOne({ email });
    expect(account).toMatchObject({ googleSub: `mock:${email}`, emailVerified: true, status: 'pending_setup' });

    // Second time: matched by googleSub — a returning account proves its
    // mailbox with a sign-in code first; same account, no duplicate.
    const again = await google(`mock-google:${email}`).expect(200);
    expect(again.body.outcome).toBe('verification_required');
    expect(again.body.challenge.purpose).toBe('sign_in');
    const done = await verify(again.body.challenge.challengeId).expect(200);
    expect(done.body.snapshot.accountId).toBe(String(account._id));
    expect(await f.models.Account.countDocuments({ email })).toBe(1);
  });

  test('unverified Google identity → verification_required, then the code finishes it', async () => {
    const email = addr('gunv');
    const res = await google(`mock-google-unverified:${email}`).expect(200);
    expect(res.body.outcome).toBe('verification_required');
    const done = await verify(res.body.challenge.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
  });

  test('verified password account: Google → sign-in code → Google linked, password kept', async () => {
    const account = await f.createAccount({ email: addr('glink'), role: 'super_admin', setupCompleted: true });
    const res = await google(`mock-google:${account.email}`).expect(200);
    expect(res.body.outcome).toBe('verification_required');
    expect(res.body.challenge.purpose).toBe('sign_in');
    // Nothing is linked before the code is right.
    expect((await f.models.Account.findById(account._id)).googleSub).toBeUndefined();
    const mail = await f.models.DevMail.findOne({ to: account.email }).sort({ createdAt: -1 });
    expect(mail.kind).toBe('signInCode');

    const wrong = await verify(res.body.challenge.challengeId, '000000').expect(422);
    expect(wrong.body.error.code).toBe('verification_code_invalid');
    const done = await verify(res.body.challenge.challengeId).expect(200);
    expect(done.body.outcome).toBe('ready');
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.googleSub).toBe(`mock:${account.email}`);
    expect([...fresh.methods].sort()).toEqual(['google', 'password']);
    await signIn(account.email).expect(200);
  });

  test('an address linked to another Google identity → sign-in code, then in; the stored identity is never replaced', async () => {
    const email = addr('gother');
    const account = await f.createAccount({ email, googleSub: 'mock:someone-else' });
    const res = await google(`mock-google:${email}`).expect(200);
    expect(res.body.outcome).toBe('verification_required');
    expect(res.body.challenge.purpose).toBe('sign_in');
    const ch = await f.models.VerificationChallenge.findById(res.body.challenge.challengeId).select('+googleSub');
    expect(ch.googleSub).toBeUndefined();
    const done = await verify(res.body.challenge.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.googleSub).toBe('mock:someone-else');
    expect([...fresh.methods]).toEqual([...account.methods]);
    expect(await f.models.Account.countDocuments({ email })).toBe(1);
  });

  test('another Google identity still → 409 for an unverified, customer demo or super_admin account', async () => {
    const accounts = [
      await f.createAccount({ email: addr('gou'), googleSub: 'mock:x1', emailVerified: false, status: 'pending_setup' }),
      await f.createAccount({ email: addr('god'), googleSub: 'mock:x2', role: 'customer_demo', setupCompleted: true }),
      await f.createAccount({ email: addr('gos'), googleSub: 'mock:x3', role: 'super_admin', setupCompleted: true }),
    ];
    for (const account of accounts) {
      const res = await google(`mock-google:${account.email}`).expect(409);
      expect(res.body.error.code).toBe('auth_method_link_required');
    }
  });

  test('claims a provisioned seat account (same _id)', async () => {
    const tenant = await f.createTenant();
    const email = addr('gprov');
    const { account } = await authorizationService.provisionSeatAccount({ tenant, name: 'هدى السالم', email, kind: 'initial_seat' });
    const res = await google(`mock-google:${email}`).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    expect(res.body.snapshot.accountId).toBe(String(account._id));
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.methods).toEqual(['google']);
    expect(fresh.emailVerified).toBe(true);
  });

  test('claims an unverified password sign-up and drops the unproven password', async () => {
    const email = addr('gclaim');
    const { body: ch } = await signUp(email).expect(202);
    const res = await google(`mock-google:${email}`).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    const fresh = await f.models.Account.findOne({ email }).select('+passwordHash');
    expect(fresh.methods).toEqual(['google']);
    expect(fresh.passwordHash).toBeUndefined();
    expect((await f.models.VerificationChallenge.findById(ch.challengeId)).status).toBe('ended');
    await signIn(email, PW).expect(401);
  });

  test('finished account signing in with its Google identity → sign-in code, then ready', async () => {
    const email = addr('gready');
    await f.createAccount({ email, role: 'super_admin', setupCompleted: true, googleSub: `mock:${email}` });
    const res = await google(`mock-google:${email}`).expect(200);
    expect(res.body.outcome).toBe('verification_required');
    expect(Object.keys(res.body.challenge).sort()).toEqual(
      ['attemptsRemaining', 'challengeId', 'codeLength', 'expiresAt', 'maskedEmail', 'purpose', 'resendAvailableAt'],
    );
    const done = await verify(res.body.challenge.challengeId).expect(200);
    expect(done.body.outcome).toBe('ready');
  });

  test('rejections: malformed mock → 401 google_assertion_rejected; real token without client id → 403 unsupported_auth_method', async () => {
    const bad = await google('mock-google:not-an-email').expect(401);
    expect(bad.body.error.code).toBe('google_assertion_rejected');
    const unsupported = await google('eyJhbGciOiJSUzI1NiJ9.e30.sig').expect(403);
    expect(unsupported.body.error.code).toBe('unsupported_auth_method');
    const noKey = await f.api().post(`${base}/google`).send({ idToken: 'mock-google:a@b.co' }).expect(422);
    expect(noKey.body.error.code).toBe('validation');
  });
});
