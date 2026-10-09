/**
 * /auth/sign-up, /auth/verification/verify, /auth/verification/resend.
 */
const f = require('./helpers/factory');
const authorizationService = require('../services/authorizationService');

const CODE = '246810';
const PW = 'Str0ng-passw0rd';
const base = '/api/v1/auth';

const signUp = (email, password = PW, headers = f.idem()) => f.api().post(`${base}/sign-up`).set(headers).send({ email, password });
const verify = (challengeId, code = CODE) => f.api().post(`${base}/verification/verify`).set(f.device()).set(f.idem()).send({ challengeId, code });
const resend = (challengeId) => f.api().post(`${base}/verification/resend`).set(f.idem()).send({ challengeId });
const addr = (p = 'su') => `${f.uniq(p)}@test.leader`;

const CHALLENGE_KEYS = ['attemptsRemaining', 'challengeId', 'codeLength', 'expiresAt', 'maskedEmail', 'resendAvailableAt'];

const expectChallenge = (body) => {
  expect(Object.keys(body).sort()).toEqual(CHALLENGE_KEYS);
  expect(body.challengeId).toMatch(/^vc_/);
  expect(body.maskedEmail).toMatch(/^.\*\*\*@test\.leader$/);
  expect(body.codeLength).toBe(6);
  expect(body.attemptsRemaining).toBe(5);
  expect(body.expiresAt).toMatch(/Z$/);
  expect(body.resendAvailableAt).toMatch(/Z$/);
};

describe('POST /auth/sign-up', () => {
  test('new address → 202 Challenge, pending_setup account, code mailed, no session', async () => {
    const email = addr();
    const res = await signUp(email).expect(202);
    expectChallenge(res.body);
    expect(res.body.accessToken).toBeUndefined();

    const account = await f.models.Account.findOne({ email });
    expect(account).toMatchObject({ status: 'pending_setup', role: null, linkStatus: 'unlinked', emailVerified: false });
    expect(account.methods).toEqual(['password']);
    expect(await f.latestCode(email)).toBe(CODE);
    expect(await f.models.Session.countDocuments({ accountId: String(account._id) })).toBe(0);
  });

  test('new / provisioned / unverified / verified all answer 202 Challenge; the verified one is a sign-in code', async () => {
    const tenant = await f.createTenant();
    const provisionedEmail = addr('prov');
    await authorizationService.provisionSeatAccount({ tenant, name: 'مدير', email: provisionedEmail, kind: 'initial_seat' });
    const unverifiedEmail = addr('unv');
    await signUp(unverifiedEmail).expect(202);
    const verified = await f.createAccount({ email: addr('ver') });

    const results = [];
    for (const email of [addr('new'), provisionedEmail, unverifiedEmail, verified.email]) {
      const res = await signUp(email);
      results.push(res);
    }
    results.slice(0, 3).forEach((res) => {
      expect(res.status).toBe(202);
      expectChallenge(res.body);
    });

    // The verified address got a real sign-in code, not a decoy.
    expect(results[3].status).toBe(202);
    const { purpose, ...rest } = results[3].body;
    expect(purpose).toBe('sign_in');
    expectChallenge(rest);
    const ch = await f.models.VerificationChallenge.findById(results[3].body.challengeId);
    expect(ch).toMatchObject({ decoy: false, accountId: String(verified._id), purpose: 'sign_in' });
    const mail = await f.models.DevMail.findOne({ to: verified.email }).sort({ createdAt: -1 });
    expect(mail.kind).toBe('signInCode');
  });

  test('provisioned seat account is CLAIMED (same _id, password attached)', async () => {
    const tenant = await f.createTenant();
    const email = addr('claim');
    const { account } = await authorizationService.provisionSeatAccount({ tenant, name: 'هدى', email, kind: 'initial_seat' });
    const res = await signUp(email).expect(202);
    const ch = await f.models.VerificationChallenge.findById(res.body.challengeId);
    expect(ch.accountId).toBe(String(account._id));
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.methods).toEqual(['password']);
    expect(await f.models.Account.countDocuments({ email })).toBe(1);
  });

  test('existing unverified account: password replaced, other challenges ended', async () => {
    const email = addr('again');
    const first = await signUp(email, 'first-password').expect(202);
    const second = await signUp(email, 'second-password').expect(202);
    const old = await f.models.VerificationChallenge.findById(first.body.challengeId);
    expect(old.status).toBe('ended');
    await verify(first.body.challengeId).expect(409);
    await verify(second.body.challengeId).expect(200);
    const account = await f.models.Account.findOne({ email }).select('+passwordHash');
    expect(await account.checkPassword('second-password')).toBe(true);
    expect(await account.checkPassword('first-password')).toBe(false);
  });

  test('verified address: the sign-in code signs in and the typed password is never stored', async () => {
    const verified = await f.createAccount({ email: addr('dec'), status: 'pending_setup' });
    const res = await signUp(verified.email).expect(202);
    const done = await verify(res.body.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
    expect(done.body.snapshot.accountId).toBe(String(verified._id));
    const account = await f.models.Account.findById(verified._id).select('+passwordHash');
    expect(await account.checkPassword(PW)).toBe(false); // untouched
    expect(await account.checkPassword(f.PASSWORD)).toBe(true);
  });

  test('customer demo and super_admin addresses still get a decoy that never verifies', async () => {
    const demo = await f.createAccount({ email: addr('ddemo'), role: 'customer_demo', setupCompleted: true });
    const platform = await f.createAccount({ email: addr('dsa'), role: 'super_admin', setupCompleted: true });
    for (const target of [demo, platform]) {
      const res = await signUp(target.email).expect(202);
      expectChallenge(res.body);
      expect(await f.models.VerificationChallenge.findById(res.body.challengeId)).toMatchObject({ decoy: true, accountId: null });
      const mail = await f.models.DevMail.findOne({ to: target.email }).sort({ createdAt: -1 });
      expect(mail.kind).toBe('signupAttemptOnVerified');
      const bad = await verify(res.body.challengeId).expect(422);
      expect(bad.body.error).toMatchObject({ code: 'verification_code_invalid', attemptsRemaining: 4 });
    }
  });

  test('password policy → 422 password_rejected with fields.password (never trimmed)', async () => {
    const short = await signUp(addr(), 'short').expect(422);
    expect(short.body.error.code).toBe('password_rejected');
    expect(short.body.error.fields.password).toBeDefined();
    const long = await signUp(addr(), 'x'.repeat(129)).expect(422);
    expect(long.body.error.code).toBe('password_rejected');
    // Taken exactly as typed: 8 characters including the spaces (3 if trimmed).
    const spaces = await signUp(addr(), '  abc   ').expect(202);
    expect(spaces.body.challengeId).toBeDefined();
    const missing = await f.api().post(`${base}/sign-up`).set(f.idem()).send({ email: addr() }).expect(422);
    expect(missing.body.error.code).toBe('password_rejected');
  });

  test('bad email → 422 validation; missing Idempotency-Key → 422 validation', async () => {
    const bad = await signUp('not-an-email').expect(422);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.fields.email).toBeDefined();
    const noKey = await f.api().post(`${base}/sign-up`).send({ email: addr(), password: PW }).expect(422);
    expect(noKey.body.error.code).toBe('validation');
    expect(noKey.body.error.fields['Idempotency-Key']).toBeDefined();
  });

  test('same Idempotency-Key + same body replays the challenge', async () => {
    const email = addr('idem');
    const headers = f.idem();
    const a = await signUp(email, PW, headers).expect(202);
    const b = await signUp(email, PW, headers).expect(202);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    expect(await f.models.VerificationChallenge.countDocuments({ email })).toBe(1);
  });
});

describe('POST /auth/verification/verify', () => {
  test('correct code → verified, challenge consumed, onboarding outcome with snapshot', async () => {
    const email = addr('ok');
    const { body: ch } = await signUp(email).expect(202);
    const res = await verify(ch.challengeId).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    expect(res.body.onboardingToken).toBeTruthy();
    expect(res.body.onboardingRefreshToken).toBeTruthy();
    const account = await f.models.Account.findOne({ email });
    expect(res.body.snapshot).toEqual({
      accountId: String(account._id),
      email,
      methods: ['password'],
      accountStatus: 'pending_setup',
      linkStatus: 'unlinked',
      setupStatus: 'required',
    });
    expect(account.emailVerified).toBe(true);
    expect((await f.models.VerificationChallenge.findById(ch.challengeId)).status).toBe('verified');
    // Single use.
    const again = await verify(ch.challengeId).expect(409);
    expect(again.body.error.code).toBe('verification_challenge_ended');
  });

  test('wrong code spends attempts; the last one ends the challenge', async () => {
    const { body: ch } = await signUp(addr('wrong')).expect(202);
    for (let left = 4; left >= 1; left -= 1) {
      const r = await verify(ch.challengeId, '000000').expect(422);
      expect(r.body.error).toMatchObject({ code: 'verification_code_invalid', attemptsRemaining: left });
    }
    const last = await verify(ch.challengeId, '000000').expect(409);
    expect(last.body.error.code).toBe('verification_challenge_ended');
    await verify(ch.challengeId).expect(409);
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'verification_failed' })).toBeGreaterThanOrEqual(5);
  });

  test('expired code → 409 verification_code_expired, no attempt spent', async () => {
    const { body: ch } = await signUp(addr('exp')).expect(202);
    await f.models.VerificationChallenge.updateOne({ _id: ch.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(ch.challengeId).expect(409);
    expect(res.body.error.code).toBe('verification_code_expired');
    expect((await f.models.VerificationChallenge.findById(ch.challengeId)).attemptsRemaining).toBe(5);
  });

  test('unknown challenge → 409 verification_challenge_ended; missing fields → 422', async () => {
    const res = await verify('vc_nope').expect(409);
    expect(res.body.error.code).toBe('verification_challenge_ended');
    const bad = await f.api().post(`${base}/verification/verify`).set(f.idem()).send({ challengeId: 'x' }).expect(422);
    expect(bad.body.error.fields.code).toBeDefined();
  });

  test('finished administrator verifying → ready', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant, { emailVerified: false });
    const signIn = await f.api().post(`${base}/sign-in`).set(f.device()).send({ email: account.email, password: f.PASSWORD }).expect(200);
    expect(signIn.body.outcome).toBe('verification_required');
    const res = await verify(signIn.body.challenge.challengeId).expect(200);
    expect(res.body.outcome).toBe('ready');
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'outcome', 'refreshToken', 'sessionId']);
  });
});

describe('POST /auth/verification/resend', () => {
  test('within the cooldown → 429 verification_resend_throttled with retryAfterSeconds', async () => {
    const { body: ch } = await signUp(addr('rs')).expect(202);
    const res = await resend(ch.challengeId).expect(429);
    expect(res.body.error.code).toBe('verification_resend_throttled');
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('after the cooldown → same challenge re-armed (attempts reset, new mail)', async () => {
    const email = addr('rs2');
    const { body: ch } = await signUp(email).expect(202);
    await verify(ch.challengeId, '111111').expect(422);
    await f.models.VerificationChallenge.updateOne({ _id: ch.challengeId }, { $set: { resendAvailableAt: new Date(Date.now() - 1000) } });
    const before = await f.models.DevMail.countDocuments({ to: email });
    const res = await resend(ch.challengeId).expect(200);
    expect(res.body.challengeId).toBe(ch.challengeId);
    expect(res.body.attemptsRemaining).toBe(5);
    expect(new Date(res.body.resendAvailableAt).getTime()).toBeGreaterThan(Date.now());
    expect(await f.models.DevMail.countDocuments({ to: email })).toBe(before + 1);
    await verify(ch.challengeId).expect(200);
  });

  test('decoys resend silently; ended/unknown → 409', async () => {
    const verified = await f.createAccount({ email: addr('rsd'), role: 'super_admin', setupCompleted: true });
    const { body: ch } = await signUp(verified.email).expect(202);
    await f.models.VerificationChallenge.updateOne({ _id: ch.challengeId }, { $set: { resendAvailableAt: new Date(Date.now() - 1000) } });
    const before = await f.models.DevMail.countDocuments({ to: verified.email });
    const res = await resend(ch.challengeId).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(CHALLENGE_KEYS);
    expect(await f.models.DevMail.countDocuments({ to: verified.email })).toBe(before);

    const gone = await resend('vc_missing').expect(409);
    expect(gone.body.error.code).toBe('verification_challenge_ended');
  });
});
