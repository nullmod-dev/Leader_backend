/**
 * (e) Password reset: request → verify → complete, enumeration safety and
 * every refusal.
 */
const f = require('./helpers/factory');

const base = '/api/v1/auth';
const CODE = '246810';
const NEW_PW = 'Brand-new-passw0rd';
const addr = (p = 'rs') => `${f.uniq(p)}@test.leader`;

const request = (email) => f.api().post(`${base}/password-reset/request`).send({ email });
const verify = (token, email, code = CODE) => f.api().post(`${base}/password-reset/verify`).set(f.auth(token)).send({ email, code });
const complete = (token, password = NEW_PW) => f.api().post(`${base}/password-reset/complete`).set(f.auth(token)).send({ password });
const signIn = (email, password) => f.api().post(`${base}/sign-in`).set(f.device()).send({ email, password });

describe('password reset', () => {
  test('full flow: code mailed → verify → complete → all sessions revoked → new password works', async () => {
    const tenant = await f.createTenant();
    const { account, token: oldToken } = await f.mainAdmin(tenant, { email: addr('full') });

    const req = await request(account.email.toUpperCase()).expect(200);
    expect(Object.keys(req.body)).toEqual(['resetToken']);
    const mail = await f.models.DevMail.findOne({ to: account.email }).sort({ createdAt: -1 });
    expect(mail.kind).toBe('passwordResetCode');
    expect(await f.latestCode(account.email)).toBe(CODE);

    // Completing before verifying is refused.
    await complete(req.body.resetToken).expect(401);

    const wrong = await verify(req.body.resetToken, account.email, '000000').expect(422);
    expect(wrong.body.error).toMatchObject({ code: 'reset_code_invalid', attemptsRemaining: 4 });
    await verify(req.body.resetToken, account.email).expect(204);

    const weak = await complete(req.body.resetToken, 'short').expect(422);
    expect(weak.body.error.code).toBe('password_rejected');
    await complete(req.body.resetToken).expect(204);

    // Single use.
    await complete(req.body.resetToken).expect(401);
    await verify(req.body.resetToken, account.email).expect(401);

    await f.api().get(`${base}/me`).set(f.auth(oldToken)).expect(401);
    await signIn(account.email, f.PASSWORD).expect(401);
    const ok = await signIn(account.email, NEW_PW).expect(200);
    expect(ok.body.outcome).toBe('ready');
  });

  test('unverified password account: reset also verifies the address', async () => {
    const email = addr('unv');
    await f.api().post(`${base}/sign-up`).set(f.idem()).send({ email, password: 'Initial-passw0rd' }).expect(202);
    const { body } = await request(email).expect(200);
    await verify(body.resetToken, email).expect(204);
    await complete(body.resetToken).expect(204);
    expect((await f.models.Account.findOne({ email })).emailVerified).toBe(true);
    // The account has no device yet: its first device proves the mailbox again.
    const res = await signIn(email, NEW_PW).expect(200);
    expect(res.body.challenge.purpose).toBe('new_device');
  });

  test('enumeration-safe: unknown and Google-only addresses get the same 200 { resetToken } and a decoy', async () => {
    const known = await f.createAccount({ email: addr('known') });
    const googleOnly = await f.createAccount({ email: addr('g') });
    await f.models.Account.updateOne({ _id: googleOnly._id }, { $set: { methods: ['google'] }, $unset: { passwordHash: '' } });
    const unknownEmail = addr('nobody');

    const results = await Promise.all([request(known.email), request(googleOnly.email), request(unknownEmail)]);
    results.forEach((r) => {
      expect(r.status).toBe(200);
      expect(Object.keys(r.body)).toEqual(['resetToken']);
    });

    const gMail = await f.models.DevMail.findOne({ to: googleOnly.email }).sort({ createdAt: -1 });
    expect(gMail.kind).toBe('googleOnlyReset');
    expect(await f.models.DevMail.countDocuments({ to: unknownEmail })).toBe(0);

    // Decoys never verify, even with the fixed dev code.
    const decoy = await verify(results[2].body.resetToken, unknownEmail).expect(422);
    expect(decoy.body.error.code).toBe('reset_code_invalid');
    const gDecoy = await verify(results[1].body.resetToken, googleOnly.email).expect(422);
    expect(gDecoy.body.error.code).toBe('reset_code_invalid');
    await complete(results[2].body.resetToken).expect(401);
  });

  test('email mismatch spends an attempt; at 0 the reset is dead (401 after)', async () => {
    const account = await f.createAccount({ email: addr('att') });
    const { body } = await request(account.email).expect(200);
    const mismatch = await verify(body.resetToken, addr('other')).expect(422);
    expect(mismatch.body.error.attemptsRemaining).toBe(4);
    for (let left = 3; left >= 0; left -= 1) {
      const r = await verify(body.resetToken, account.email, '999999').expect(422);
      expect(r.body.error.attemptsRemaining).toBe(left);
    }
    const dead = await verify(body.resetToken, account.email).expect(401);
    expect(dead.body.error.code).toBe('authentication_expired');
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'reset_failed' })).toBeGreaterThanOrEqual(5);
  });

  test('expired code → 409 reset_code_expired', async () => {
    const account = await f.createAccount({ email: addr('exp') });
    const { body } = await request(account.email).expect(200);
    await f.models.PasswordReset.updateOne({ email: account.email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(body.resetToken, account.email).expect(409);
    expect(res.body.error.code).toBe('reset_code_expired');
  });

  test('a newer request kills the older reset', async () => {
    const account = await f.createAccount({ email: addr('newer') });
    const first = await request(account.email).expect(200);
    const second = await request(account.email).expect(200);
    await verify(first.body.resetToken, account.email).expect(401);
    await verify(second.body.resetToken, account.email).expect(204);
  });

  test('bad / missing reset bearer → 401 authentication_expired; an access token is not a reset token', async () => {
    const { token } = await f.superAdmin();
    for (const t of [null, 'garbage', token]) {
      const req = f.api().post(`${base}/password-reset/verify`);
      if (t) req.set(f.auth(t));
      const res = await req.send({ email: 'a@b.co', code: CODE }).expect(401);
      expect(res.body.error.code).toBe('authentication_expired');
    }
  });

  test('validation: malformed email on request, missing code on verify → 422', async () => {
    const bad = await request('nope').expect(422);
    expect(bad.body.error.fields.email).toBeDefined();
    const account = await f.createAccount({ email: addr('val') });
    const { body } = await request(account.email).expect(200);
    const missing = await f.api().post(`${base}/password-reset/verify`).set(f.auth(body.resetToken)).send({ email: account.email }).expect(422);
    expect(missing.body.error.fields.code).toBeDefined();
  });
});
