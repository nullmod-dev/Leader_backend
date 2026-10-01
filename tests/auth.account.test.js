/**
 * The signed-in account: /me (+ avatar, password), /sessions, /new-device,
 * and the MFA lifecycle.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { authenticator } = require('otplib');
const f = require('./helpers/factory');

const base = '/api/v1/auth';
const addr = (p = 'ac') => `${f.uniq(p)}@test.leader`;
const signIn = (email, password = f.PASSWORD, device) => {
  const req = f.api().post(`${base}/sign-in`);
  if (device) req.set('X-Device-Name', device);
  return req.send({ email, password });
};
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));

/** A finished Main Admin signed in over HTTP. */
const signedInAdmin = async (overrides = {}) => {
  const tenant = await f.createTenant();
  const { account } = await f.mainAdmin(tenant, { email: addr('adm'), ...overrides });
  const { body } = await signIn(account.email).expect(200);
  return { tenant, account, token: body.accessToken, refreshToken: body.refreshToken };
};

describe('GET /auth/me', () => {
  test('{ user, access } for a Main Admin', async () => {
    const { tenant, account, token } = await signedInAdmin();
    const res = await me(token).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['access', 'user']);
    expect(res.body.user).toMatchObject({
      id: String(account._id),
      email: account.email,
      role: 'main_admin',
      saasTenantId: String(tenant._id),
      orgName: tenant.displayName,
    });
    expect(res.body.access).toEqual({ accountStatus: 'active', tenantStatus: 'active', demoMode: 'none', mfaRequired: false });
  });

  test('super_admin → saasTenantId null and no capabilities', async () => {
    const { token } = await f.superAdmin();
    const res = await me(token).expect(200);
    expect(res.body.user.saasTenantId).toBeNull();
    expect(res.body.user.capabilities).toEqual({ global: [], scoped: {} });
  });

  test('customer_demo → demoMode from its DemoSession', async () => {
    const account = await f.createAccount({ email: addr('demo'), role: 'customer_demo', setupCompleted: true });
    const demo = await f.models.DemoSession.create({
      accountId: String(account._id),
      demoWorkspaceId: 'dw_1',
      expiresAt: new Date(Date.now() + 3600000),
      policyRevision: 1,
    });
    account.demoSessionId = String(demo._id);
    await account.save();
    const { token } = await f.login(account);
    const res = await me(token).expect(200);
    expect(res.body.user.saasTenantId).toBeNull();
    expect(res.body.access.demoMode).toBe('active');
    expect(res.body.access.sessionExpiresAt).toBe(demo.expiresAt.toISOString());
  });

  test('no bearer / garbage bearer → 401 authentication_expired', async () => {
    await f.api().get(`${base}/me`).expect(401);
    const res = await me('garbage').expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });
});

describe('PATCH /auth/me', () => {
  test('collapses and saves the name', async () => {
    const { token } = await signedInAdmin();
    const res = await f.api().patch(`${base}/me`).set(f.auth(token)).send({ name: '  سلمى    الحارثي ' }).expect(200);
    expect(res.body.user.name).toBe('سلمى الحارثي');
    expect(res.body.user.avatarInitials).toBeTruthy();
    expect(res.body.access).toBeDefined();
  });

  test('empty / too long / missing → 422 validation', async () => {
    const { token } = await signedInAdmin();
    for (const body of [{ name: '   ' }, { name: 'a'.repeat(81) }, {}]) {
      const res = await f.api().patch(`${base}/me`).set(f.auth(token)).send(body).expect(422);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.fields.name).toBeDefined();
    }
  });

  test('onboarding session → 403 onboarding_required', async () => {
    const account = await f.createAccount({ email: addr('ob'), status: 'pending_setup' });
    const { token } = await f.login(account, 'onboarding');
    const res = await f.api().patch(`${base}/me`).set(f.auth(token)).send({ name: 'x' }).expect(403);
    expect(res.body.error.code).toBe('onboarding_required');
  });
});

describe('(i) avatar', () => {
  const png = () => sharp({ create: { width: 80, height: 80, channels: 3, background: '#3a7' } }).png().toBuffer();
  const diskPath = (url) => path.join(__dirname, '..', 'public', ...new URL(url).pathname.split('/').filter(Boolean));

  test('upload → avatarUrl served at /images/avatars/...; replace removes the old file; delete clears it', async () => {
    const { tenant, token } = await signedInAdmin();
    const first = await f.api().post(`${base}/me/avatar`).set(f.auth(token)).attach('image', await png(), 'a.png').expect(200);
    const url = first.body.user.avatarUrl;
    expect(url).toMatch(/^http:\/\/localhost:4000\/images\/avatars\/account-.*\.webp$/);
    const served = await f.api().get(new URL(url).pathname).expect(200);
    expect(served.headers['content-type']).toMatch(/image\/webp/);
    expect((await f.models.SaasTenant.findById(tenant._id)).usage.storageUsedBytes).toBeGreaterThan(0);

    const second = await f.api().post(`${base}/me/avatar`).set(f.auth(token)).attach('image', await png(), 'b.png').expect(200);
    expect(second.body.user.avatarUrl).not.toBe(url);
    expect(fs.existsSync(diskPath(url))).toBe(false);

    const removed = await f.api().delete(`${base}/me/avatar`).set(f.auth(token)).expect(200);
    expect(removed.body.user.avatarUrl).toBeUndefined();
    expect(fs.existsSync(diskPath(second.body.user.avatarUrl))).toBe(false);
    expect((await f.models.SaasTenant.findById(tenant._id)).usage.storageUsedBytes).toBe(0);
  });

  test('missing file / not an image → 422 validation', async () => {
    const { token } = await signedInAdmin();
    const missing = await f.api().post(`${base}/me/avatar`).set(f.auth(token)).expect(422);
    expect(missing.body.error.fields.image).toBeDefined();
    const junk = await f.api()
      .post(`${base}/me/avatar`)
      .set(f.auth(token))
      .attach('image', Buffer.from('not really a png'), { filename: 'x.png', contentType: 'image/png' })
      .expect(422);
    expect(junk.body.error.fields.image).toBeDefined();
  });
});

describe('POST /auth/me/password', () => {
  test('wrong current → 422 invalid_credentials; weak new → 422 password_rejected; success revokes OTHER sessions', async () => {
    const { account, token } = await signedInAdmin();
    const other = await signIn(account.email).expect(200);

    const wrong = await f.api().post(`${base}/me/password`).set(f.auth(token)).send({ currentPassword: 'nope', newPassword: 'N3w-password!' }).expect(422);
    expect(wrong.body.error).toMatchObject({ code: 'invalid_credentials' });
    expect(wrong.body.error.fields.currentPassword).toBeDefined();

    const weak = await f.api().post(`${base}/me/password`).set(f.auth(token)).send({ currentPassword: f.PASSWORD, newPassword: 'short' }).expect(422);
    expect(weak.body.error.code).toBe('password_rejected');
    expect(weak.body.error.fields.newPassword).toBeDefined();

    await f.api().post(`${base}/me/password`).set(f.auth(token)).send({ currentPassword: f.PASSWORD, newPassword: 'N3w-password!' }).expect(204);
    await me(token).expect(200);
    await me(other.body.accessToken).expect(401);
    await signIn(account.email).expect(401);
    await signIn(account.email, 'N3w-password!').expect(200);
  });
});

describe('/auth/sessions', () => {
  test('list live full sessions newest first, current flagged; revoke one; revoke others', async () => {
    const { account, token } = await signedInAdmin();
    const phone = await signIn(account.email, f.PASSWORD, 'Pixel 8').expect(200);
    const tablet = await signIn(account.email, f.PASSWORD, 'iPad').expect(200);
    // An onboarding-tier or revoked session never appears.
    const dead = await signIn(account.email).expect(200);
    await f.api().post(`${base}/sign-out`).set(f.auth(dead.body.accessToken)).expect(204);

    const list = await f.api().get(`${base}/sessions`).set(f.auth(token)).expect(200);
    // factory session ('jest') + this sign-in + Pixel + iPad; the signed-out one is gone.
    expect(list.body).toHaveLength(4);
    expect(Object.keys(list.body[0]).sort()).toEqual(['current', 'device', 'id', 'ipMasked', 'lastUsedAt', 'locationLabel', 'startedAt']);
    expect(list.body[0].device).toBe('iPad');
    expect(list.body.filter((s) => s.current)).toHaveLength(1);
    const current = list.body.find((s) => s.current);
    expect(list.body[2].id).toBe(current.id);
    expect(current.ipMasked).toMatch(/xx/);

    const self = await f.api().delete(`${base}/sessions/${current.id}`).set(f.auth(token)).expect(422);
    expect(self.body.error.code).toBe('validation');
    const unknown = await f.api().delete(`${base}/sessions/s_nope`).set(f.auth(token)).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
    const foreign = await f.superAdmin();
    await f.api().delete(`${base}/sessions/${foreign.session._id}`).set(f.auth(token)).expect(404);

    const tabletId = list.body.find((s) => s.device === 'iPad').id;
    await f.api().delete(`${base}/sessions/${tabletId}`).set(f.auth(token)).expect(204);
    await me(tablet.body.accessToken).expect(401);

    const all = await f.api().delete(`${base}/sessions`).set(f.auth(token)).expect(200);
    expect(all.body).toEqual({ revoked: 2 });
    await me(phone.body.accessToken).expect(401);
    await me(token).expect(200);
  });
});

describe('POST /auth/new-device/confirm', () => {
  test('itsMe true marks the session; itsMe false ends every session', async () => {
    const { account, token } = await signedInAdmin();
    await f.api().post(`${base}/new-device/confirm`).set(f.auth(token)).send({ itsMe: true }).expect(204);
    const sessions = await f.models.Session.find({ accountId: String(account._id), revokedAt: { $exists: false } });
    expect(sessions.some((s) => s.newDeviceConfirmed)).toBe(true);

    const other = await signIn(account.email).expect(200);
    await f.api().post(`${base}/new-device/confirm`).set(f.auth(other.body.accessToken)).send({ itsMe: false }).expect(204);
    await me(token).expect(401);
    await me(other.body.accessToken).expect(401);
  });

  test('missing itsMe → 422 validation', async () => {
    const { token } = await signedInAdmin();
    const res = await f.api().post(`${base}/new-device/confirm`).set(f.auth(token)).send({}).expect(422);
    expect(res.body.error.fields.itsMe).toBeDefined();
  });
});

describe('(d) MFA', () => {
  test('setup → verify enables; a new sign-in is mfaRequired until /mfa/verify with a TOTP', async () => {
    const { account, token } = await signedInAdmin();
    const setup = await f.api().post(`${base}/mfa/setup`).set(f.auth(token)).expect(200);
    expect(Object.keys(setup.body).sort()).toEqual(['backupCodes', 'manualSecret', 'otpauthUrl']);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Leader:/);
    expect(setup.body.otpauthUrl).toContain('issuer=Leader');
    expect(setup.body.backupCodes).toHaveLength(8);
    setup.body.backupCodes.forEach((c) => expect(c).toMatch(/^[a-z0-9]{10}$/));
    const secret = setup.body.manualSecret;

    // Setup alone does not enable MFA.
    expect((await me(token).expect(200)).body.access.mfaRequired).toBe(false);
    expect((await f.models.Account.findById(account._id)).mfa.enabled).toBe(false);

    const wrong = await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: '000000' }).expect(422);
    expect(wrong.body.error.code).toBe('mfa_code_invalid');
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'mfa_failed', accountId: String(account._id) })).toBe(1);

    await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: authenticator.generate(secret) }).expect(204);
    expect((await f.models.Account.findById(account._id)).mfa.enabled).toBe(true);
    expect((await me(token).expect(200)).body.access.mfaRequired).toBe(false);

    // Already enabled → setup refuses.
    const again = await f.api().post(`${base}/mfa/setup`).set(f.auth(token)).expect(409);
    expect(again.body.error.code).toBe('conflict');
    // Nothing left to verify on this session.
    await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: authenticator.generate(secret) }).expect(409);

    // A fresh sign-in must pass the second factor.
    const { body: s2 } = await signIn(account.email).expect(200);
    expect(s2.outcome).toBe('ready');
    expect((await me(s2.accessToken).expect(200)).body.access.mfaRequired).toBe(true);
    const blocked = await f.api().get(`${base}/sessions`).set(f.auth(s2.accessToken)).expect(403);
    expect(blocked.body.error.code).toBe('mfa_required');
    await f.api().post(`${base}/mfa/verify`).set(f.auth(s2.accessToken)).send({ code: '123' }).expect(422);
    await f.api().post(`${base}/mfa/verify`).set(f.auth(s2.accessToken)).send({ code: authenticator.generate(secret) }).expect(204);
    await f.api().get(`${base}/sessions`).set(f.auth(s2.accessToken)).expect(200);
    expect((await me(s2.accessToken).expect(200)).body.access.mfaRequired).toBe(false);

    // A backup code works exactly once.
    const backup = setup.body.backupCodes[0];
    const { body: s3 } = await signIn(account.email).expect(200);
    await f.api().post(`${base}/mfa/verify`).set(f.auth(s3.accessToken)).send({ code: backup.toUpperCase() }).expect(204);
    const { body: s4 } = await signIn(account.email).expect(200);
    await f.api().post(`${base}/mfa/verify`).set(f.auth(s4.accessToken)).send({ code: backup }).expect(422);

    // Disable: needs a verified session + a valid code.
    await f.api().post(`${base}/mfa/disable`).set(f.auth(s4.accessToken)).send({ code: authenticator.generate(secret) }).expect(403);
    await f.api().post(`${base}/mfa/disable`).set(f.auth(token)).send({ code: '000000' }).expect(422);
    await f.api().post(`${base}/mfa/disable`).set(f.auth(token)).send({ code: authenticator.generate(secret) }).expect(204);
    const off = await f.models.Account.findById(account._id).select('+mfa.secret +mfa.backupCodeHashes');
    expect(off.mfa.enabled).toBe(false);
    expect(off.mfa.secret).toBeUndefined();
    expect(off.mfa.backupCodeHashes).toEqual([]);
    await f.api().post(`${base}/mfa/disable`).set(f.auth(token)).send({ code: '000000' }).expect(409);
  });

  test('enabling MFA puts the account\'s OTHER open sessions behind the second factor', async () => {
    const { account, token } = await signedInAdmin();
    const other = await signIn(account.email).expect(200);
    const { body } = await f.api().post(`${base}/mfa/setup`).set(f.auth(token)).expect(200);
    await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: authenticator.generate(body.manualSecret) }).expect(204);
    expect((await me(other.body.accessToken).expect(200)).body.access.mfaRequired).toBe(true);
  });

  test('nothing to verify → 409 conflict; missing code → 422; too many failures → 429', async () => {
    const { token } = await signedInAdmin();
    const none = await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: '123456' }).expect(409);
    expect(none.body.error.code).toBe('conflict');
    await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({}).expect(422);

    await f.api().post(`${base}/mfa/setup`).set(f.auth(token)).expect(200);
    for (let i = 0; i < 10; i += 1) await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: '000000' }).expect(422);
    const limited = await f.api().post(`${base}/mfa/verify`).set(f.auth(token)).send({ code: '000000' }).expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });
});
