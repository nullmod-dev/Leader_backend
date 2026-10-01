/**
 * Onboarding: snapshot, Team Code link, setup completion, and the two
 * end-to-end journeys (Main Admin seat by Team Code, Simple Admin invitation
 * by auto-link).
 */
const f = require('./helpers/factory');
const authorizationService = require('../services/authorizationService');
const { grantFromKeys } = require('../config/capabilities');

const base = '/api/v1/auth';
const CODE = '246810';
const PW = 'Str0ng-passw0rd';

const addr = (p = 'ob') => `${f.uniq(p)}@test.leader`;
const signUp = (email, password = PW) => f.api().post(`${base}/sign-up`).set(f.idem()).send({ email, password });
const verify = (challengeId, code = CODE) => f.api().post(`${base}/verification/verify`).set(f.idem()).send({ challengeId, code });
const snapshot = (token) => f.api().get(`${base}/onboarding`).set(f.auth(token));
const link = (token, teamCode) => f.api().post(`${base}/onboarding/link`).set(f.auth(token)).set(f.idem()).send({ teamCode });
const complete = (token, displayName, headers = f.idem()) =>
  f.api().post(`${base}/onboarding/complete`).set(f.auth(token)).set(headers).send({ displayName });
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));

/** sign-up → verify → onboarding outcome body. */
const onboard = async (email) => {
  const { body: ch } = await signUp(email).expect(202);
  const { body } = await verify(ch.challengeId).expect(200);
  expect(body.outcome).toBe('onboarding');
  return body;
};

/** A verified, unlinked identity with an onboarding session. */
const unlinkedIdentity = async (overrides = {}) => {
  const account = await f.createAccount({ email: addr('id'), status: 'pending_setup', name: '', ...overrides });
  const s = await f.login(account, 'onboarding');
  return { account, token: s.token, session: s.session };
};

const seatFor = async (tenant, email, overrides = {}) =>
  f.models.Authorization.create({
    tenantId: String(tenant._id),
    kind: 'initial_seat',
    email,
    role: 'main_admin',
    suggestedName: 'مدير الفريق',
    expiresAt: new Date(Date.now() + 7 * 86400000),
    ...overrides,
  });

describe('journey (a): sign-up → verify → link by Team Code → complete → Main Admin', () => {
  test('seat authorization via provisionSeatAccount', async () => {
    const tenant = await f.createTenant({ displayName: 'فريق النبض' });
    const email = addr('seat');
    const { account: provisioned } = await authorizationService.provisionSeatAccount({
      tenant,
      name: 'هدى السالم',
      email,
      kind: 'initial_seat',
    });

    const outcome = await onboard(email);
    expect(outcome.snapshot).toMatchObject({
      accountId: String(provisioned._id),
      linkStatus: 'unlinked',
      setupStatus: 'required',
      accountStatus: 'pending_setup',
    });
    expect(outcome.snapshot.tenant).toBeUndefined();
    const token = outcome.onboardingToken;

    const read = await snapshot(token).expect(200);
    expect(read.body.linkStatus).toBe('unlinked');

    // Typed loosely: lowercase, no prefix, spaces.
    const typed = tenant.teamCode.replace('MTM-', '').replace('-', ' ').toLowerCase();
    const linked = await link(token, typed).expect(200);
    expect(linked.body).toMatchObject({
      linkStatus: 'linked',
      tenant: { displayName: 'فريق النبض', role: 'main_admin', tenantStatus: 'active' },
      displayNameSuggestion: 'هدى السالم',
    });
    expect(linked.body.authorizationExpiresAt).toMatch(/Z$/);
    // Never a tenant id, Team Code, counts or capabilities.
    const text = JSON.stringify(linked.body);
    expect(text).not.toContain(String(tenant._id));
    expect(text).not.toContain(tenant.teamCode);
    expect(linked.body.capabilities).toBeUndefined();

    // Linking again with the same tenant's code is an idempotent success.
    await link(token, tenant.teamCode).expect(200);

    const done = await complete(token, '  هدى   السالم ').expect(200);
    expect(Object.keys(done.body).sort()).toEqual(['accessToken', 'outcome', 'refreshToken']);
    expect(done.body.outcome).toBe('ready');

    // The onboarding session is consumed.
    await snapshot(token).expect(401);

    const who = await me(done.body.accessToken).expect(200);
    expect(who.body.user).toMatchObject({
      id: String(provisioned._id),
      name: 'هدى السالم',
      role: 'main_admin',
      saasTenantId: String(tenant._id),
      orgName: 'فريق النبض',
    });
    expect(who.body.access).toMatchObject({ accountStatus: 'active', tenantStatus: 'active', demoMode: 'none', mfaRequired: false });
    const freshTenant = await f.models.SaasTenant.findById(tenant._id);
    expect(freshTenant.seat.currentAccountId).toBe(String(provisioned._id));
  });
});

describe('journey (b): Simple Admin invitation auto-links on verify', () => {
  test('complete → admin with the invitation grant; replay with the same key returns the same body', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const det = await f.detachment(tenant);
    const email = addr('inv');
    const grant = grantFromKeys(['member.view', 'shift.manage'], [String(det._id)]);
    const az = await f.models.Authorization.create({
      tenantId: String(tenant._id),
      kind: 'simple_admin',
      email,
      role: 'admin',
      capabilities: grant,
      suggestedName: 'نورة العتيبي',
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });

    const outcome = await onboard(email);
    expect(outcome.snapshot).toMatchObject({
      linkStatus: 'linked',
      tenant: { displayName: tenant.displayName, role: 'admin', tenantStatus: 'active' },
      displayNameSuggestion: 'نورة العتيبي',
    });

    const key = f.idem();
    const first = await complete(outcome.onboardingToken, 'نورة العتيبي', key).expect(200);
    expect(first.body.outcome).toBe('ready');
    // Replay AFTER the onboarding session was consumed: same body, no second effect.
    const replay = await complete(outcome.onboardingToken, 'نورة العتيبي', key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    // A new key on the consumed session is refused.
    await complete(outcome.onboardingToken, 'نورة العتيبي').expect(401);

    const who = await me(first.body.accessToken).expect(200);
    expect(who.body.user.role).toBe('admin');
    expect(who.body.user.capabilities).toEqual({ global: [], scoped: { [String(det._id)]: ['member.view', 'shift.manage'] } });

    const accepted = await f.models.Authorization.findById(az._id);
    expect(accepted.status).toBe('accepted');
    expect(await f.models.Account.countDocuments({ saasTenantId: String(tenant._id), role: 'admin' })).toBe(1);
    expect(await f.models.AuditEvent.countDocuments({ action: 'admin_invitation_accepted' })).toBe(1);
    expect(await f.models.Session.countDocuments({ accountId: who.body.user.id, scope: 'full' })).toBe(1);
  });

  test('auto-link happens on GET /onboarding when the invitation arrives later', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const { account, token } = await unlinkedIdentity();
    await snapshot(token).expect(200);
    await f.models.Authorization.create({
      tenantId: String(tenant._id),
      kind: 'simple_admin',
      email: account.email,
      role: 'admin',
      expiresAt: new Date(Date.now() + 86400000),
    });
    const res = await snapshot(token).expect(200);
    expect(res.body.linkStatus).toBe('linked');
    expect(res.body.tenant.role).toBe('admin');
  });

  test('a withdrawn invitation reads as linkStatus withdrawn (no tenant)', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const { account, token } = await unlinkedIdentity();
    const az = await f.models.Authorization.create({
      tenantId: String(tenant._id),
      kind: 'simple_admin',
      email: account.email,
      role: 'admin',
      expiresAt: new Date(Date.now() + 86400000),
    });
    expect((await snapshot(token).expect(200)).body.linkStatus).toBe('linked');
    az.status = 'cancelled';
    await az.save();
    const res = await snapshot(token).expect(200);
    expect(res.body.linkStatus).toBe('withdrawn');
    expect(res.body.tenant).toBeUndefined();
    const refused = await complete(token, 'اسم').expect(409);
    expect(refused.body.error.code).toBe('setup_unavailable');
  });
});

describe('POST /auth/onboarding/link refusals', () => {
  test('malformed → 422 team_code_malformed (spends nothing)', async () => {
    const { account, token } = await unlinkedIdentity();
    for (const code of ['MTM-12', 'hello', 'MTM-1111-0000']) {
      const res = await link(token, code).expect(422);
      expect(res.body.error.code).toBe('team_code_malformed');
    }
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'team_link_failed', accountId: String(account._id) })).toBe(0);
  });

  test('unknown code and code without a seat for this address → the SAME 403 team_link_refused', async () => {
    const tenant = await f.createTenant();
    await seatFor(tenant, addr('someone-else'));
    const { account, token } = await unlinkedIdentity();
    const unknown = await link(token, 'MTM-2222-3333').expect(403);
    const noSeat = await link(token, tenant.teamCode).expect(403);
    const strip = (b) => ({ ...b.error, reference: undefined });
    expect(strip(unknown.body)).toEqual(strip(noSeat.body));
    expect(unknown.body.error.code).toBe('team_link_refused');
    expect(await f.models.SecuritySignal.countDocuments({ kind: 'team_link_failed', accountId: String(account._id) })).toBe(2);
  });

  test('expired authorization → 409 invitation_expired', async () => {
    const tenant = await f.createTenant();
    const { account, token } = await unlinkedIdentity();
    await seatFor(tenant, account.email, { expiresAt: new Date(Date.now() - 1000) });
    const res = await link(token, tenant.teamCode).expect(409);
    expect(res.body.error.code).toBe('invitation_expired');
  });

  test('tenant not active → 409 tenant_unavailable with tenantStatus', async () => {
    const tenant = await f.createTenant({ lifecycle: { status: 'suspended', version: 2 } });
    const { account, token } = await unlinkedIdentity();
    await seatFor(tenant, account.email);
    const res = await link(token, tenant.teamCode).expect(409);
    expect(res.body.error).toMatchObject({ code: 'tenant_unavailable', tenantStatus: 'suspended' });
  });

  test('already linked: other tenant → 409 account_already_linked; same tenant → 200', async () => {
    const t1 = await f.createTenant();
    const t2 = await f.createTenant();
    const { account, token } = await unlinkedIdentity();
    await seatFor(t1, account.email);
    await seatFor(t2, account.email);
    await link(token, t1.teamCode).expect(200);
    const other = await link(token, t2.teamCode).expect(409);
    expect(other.body.error.code).toBe('account_already_linked');
    expect(JSON.stringify(other.body)).not.toContain(t1.displayName);
    const unknown = await link(token, 'MTM-2222-3333').expect(409);
    expect(unknown.body.error.code).toBe('account_already_linked');
    const same = await link(token, t1.teamCode).expect(200);
    expect(same.body.tenant.displayName).toBe(t1.displayName);
  });

  test('suspended account → 403 account_unavailable', async () => {
    const tenant = await f.createTenant();
    const { account, token } = await unlinkedIdentity({ status: 'suspended' });
    await seatFor(tenant, account.email);
    const res = await link(token, tenant.teamCode).expect(403);
    expect(res.body.error.code).toBe('account_unavailable');
  });

  test('10 failed links within an hour → 429 rate_limited', async () => {
    const { token } = await unlinkedIdentity();
    for (let i = 0; i < 10; i += 1) await link(token, 'MTM-2222-3333').expect(403);
    const res = await link(token, 'MTM-2222-3333').expect(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('missing Idempotency-Key → 422; missing teamCode → 422 validation', async () => {
    const { token } = await unlinkedIdentity();
    const noKey = await f.api().post(`${base}/onboarding/link`).set(f.auth(token)).send({ teamCode: 'MTM-2222-3333' }).expect(422);
    expect(noKey.body.error.fields['Idempotency-Key']).toBeDefined();
    const noCode = await f.api().post(`${base}/onboarding/link`).set(f.auth(token)).set(f.idem()).send({}).expect(422);
    expect(noCode.body.error.fields.teamCode).toBeDefined();
  });
});

describe('POST /auth/onboarding/complete refusals', () => {
  test('unlinked → 409 setup_unavailable', async () => {
    const { token } = await unlinkedIdentity();
    const res = await complete(token, 'اسم').expect(409);
    expect(res.body.error.code).toBe('setup_unavailable');
  });

  test('display name empty / too long → 422 validation; missing key → 422', async () => {
    const tenant = await f.createTenant();
    const { account, token } = await unlinkedIdentity();
    await seatFor(tenant, account.email);
    await link(token, tenant.teamCode).expect(200);
    const empty = await complete(token, '   ').expect(422);
    expect(empty.body.error.fields.displayName).toBeDefined();
    const long = await complete(token, 'ا'.repeat(81)).expect(422);
    expect(long.body.error.code).toBe('validation');
    const noKey = await f.api().post(`${base}/onboarding/complete`).set(f.auth(token)).send({ displayName: 'x' }).expect(422);
    expect(noKey.body.error.fields['Idempotency-Key']).toBeDefined();
  });

  test('expired invitation at completion → 409 invitation_expired; suspended tenant → 409 tenant_unavailable', async () => {
    const tenant = await f.createTenant();
    const { account, token } = await unlinkedIdentity();
    const az = await seatFor(tenant, account.email);
    await link(token, tenant.teamCode).expect(200);
    await f.models.SaasTenant.updateOne({ _id: tenant._id }, { $set: { 'lifecycle.status': 'suspended' } });
    const suspended = await complete(token, 'اسم').expect(409);
    expect(suspended.body.error).toMatchObject({ code: 'tenant_unavailable', tenantStatus: 'suspended' });
    await f.models.SaasTenant.updateOne({ _id: tenant._id }, { $set: { 'lifecycle.status': 'active' } });
    await f.models.Authorization.updateOne({ _id: az._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await complete(token, 'اسم').expect(409);
    expect(expired.body.error.code).toBe('invitation_expired');
  });

  test('revoked account → 403 account_unavailable', async () => {
    const tenant = await f.createTenant();
    const { account, token } = await unlinkedIdentity();
    await seatFor(tenant, account.email);
    await link(token, tenant.teamCode).expect(200);
    await f.models.Account.updateOne({ _id: account._id }, { $set: { status: 'revoked' } });
    const res = await complete(token, 'اسم').expect(403);
    expect(res.body.error.code).toBe('account_unavailable');
  });
});

describe('(g) session tiers', () => {
  test('onboarding token on GET /me → 403 onboarding_required', async () => {
    const { token } = await unlinkedIdentity();
    const res = await me(token).expect(403);
    expect(res.body.error.code).toBe('onboarding_required');
  });

  test('full token on onboarding endpoints → 409 setup_already_completed', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const res = await snapshot(main.token).expect(409);
    expect(res.body.error.code).toBe('setup_already_completed');
    const done = await complete(main.token, 'x').expect(409);
    expect(done.body.error.code).toBe('setup_already_completed');
  });

  test('no bearer → 401 authentication_expired', async () => {
    const res = await f.api().get(`${base}/onboarding`).expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });
});
