/**
 * Platform configuration: /platform/plans, /platform/settings,
 * /platform/admins, /platform/accounts.
 */
const f = require('./helpers/factory');

const API = '/api/v1/platform';

let sa;
let main;
let tenant;

beforeAll(async () => {
  await f.ensurePlans();
  sa = await f.superAdmin();
  ({ tenant, main } = await f.tenantWithMainAdmin());
});

const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
};

const as = (token) => ({
  get: (path) => f.api().get(`${API}${path}`).set(f.auth(token)),
  post: (path, body) => f.api().post(`${API}${path}`).set(f.auth(token)).send(body),
  patch: (path, body) => f.api().patch(`${API}${path}`).set(f.auth(token)).send(body),
  del: (path) => f.api().delete(`${API}${path}`).set(f.auth(token)),
});

const limits = { detachment_groups: 3, detachments: 8, admins: 4, members: 120, workshops: 20, storage_bytes: 10737418240 };

describe('tenant roles are refused on every configuration family', () => {
  test.each([
    ['get', '/plans'],
    ['post', '/plans'],
    ['get', '/settings'],
    ['patch', '/settings'],
    ['get', '/admins'],
    ['post', '/admins'],
    ['get', '/accounts'],
    ['post', '/accounts/u_x/sign-out-all'],
  ])('%s %s → 403 not_permitted', async (method, path) => {
    const client = as(main.token);
    const res = await (method === 'get' ? client.get(path) : client[method](path, {}));
    expectError(res, 403, 'not_permitted');
  });
});

describe('/platform/plans', () => {
  test('list is ordered and carries no internal fields', async () => {
    const res = await as(sa.token).get('/plans').expect(200);
    expect(res.body.slice(0, 3).map((p) => p.id)).toEqual(['mtm_core', 'mtm_standard', 'mtm_advanced']);
    expect(Object.keys(res.body[1]).sort()).toEqual(['defaultLimits', 'description', 'id', 'name', 'recommended', 'selectable']);
  });

  test('create → 201, appended last; duplicate id → 409 conflict', async () => {
    const res = await as(sa.token)
      .post('/plans', { id: 'mtm_pilot', name: '  ليدر   التجريبية ', description: 'للتجارب', defaultLimits: limits })
      .expect(201);
    expect(res.body).toEqual({ id: 'mtm_pilot', name: 'ليدر التجريبية', description: 'للتجارب', recommended: false, selectable: true, defaultLimits: limits });
    const all = await as(sa.token).get('/plans').expect(200);
    expect(all.body[all.body.length - 1].id).toBe('mtm_pilot');
    expect(await f.models.AuditEvent.exists({ action: 'plan_created', 'target.id': 'mtm_pilot' })).not.toBeNull();

    expectError(await as(sa.token).post('/plans', { id: 'mtm_pilot', name: 'x', defaultLimits: limits }), 409, 'conflict');
  });

  test('create validation: id pattern, every limit key, integers ≥ 0', async () => {
    const bad = await as(sa.token).post('/plans', { id: 'Bad-Id', name: 'x', defaultLimits: { ...limits, members: -1, workshops: 1.5, storage_bytes: undefined } });
    expectError(bad, 422, 'validation');
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(['id', 'defaultLimits.members', 'defaultLimits.workshops', 'defaultLimits.storage_bytes']));
  });

  test('patch is partial (limits merge); unknown → 404; empty → 422', async () => {
    await as(sa.token).post('/plans', { id: 'mtm_patchme', name: 'قبل', defaultLimits: limits }).expect(201);
    const res = await as(sa.token).patch('/plans/mtm_patchme', { name: 'بعد', selectable: false, defaultLimits: { members: 999 } }).expect(200);
    expect(res.body).toMatchObject({ name: 'بعد', selectable: false, defaultLimits: { ...limits, members: 999 } });
    expect(await f.models.AuditEvent.exists({ action: 'plan_updated', 'target.id': 'mtm_patchme' })).not.toBeNull();
    expectError(await as(sa.token).patch('/plans/mtm_ghost', { name: 'x' }), 404, 'not_found');
    expectError(await as(sa.token).patch('/plans/mtm_patchme', {}), 422, 'validation');
  });

  test('delete: unused → 204; referenced by a tenant → 409 conflict', async () => {
    await as(sa.token).post('/plans', { id: 'mtm_gone', name: 'مؤقتة', defaultLimits: limits }).expect(201);
    await as(sa.token).del('/plans/mtm_gone').expect(204);
    expect(await f.models.Plan.exists({ _id: 'mtm_gone' })).toBeNull();
    expectError(await as(sa.token).del('/plans/mtm_standard'), 409, 'conflict');
    expectError(await as(sa.token).del('/plans/mtm_gone'), 404, 'not_found');
  });
});

describe('/platform/settings', () => {
  let original;
  beforeAll(async () => {
    original = (await as(sa.token).get('/settings').expect(200)).body;
  });
  afterAll(() =>
    f.setSettings({ trialDays: original.trialDays, 'otp.length': original.otp.length, 'support.telegram': original.support.telegram, minimumClientVersion: '1.0.0' }),
  );

  test('GET → policy values without demo policy or internals', async () => {
    expect(original).toMatchObject({
      minimumClientVersion: '1.0.0',
      defaultTimezone: 'Asia/Damascus',
      trialDays: 14,
      graceDays: 14,
      deletionWindowDays: 30,
      otp: { length: 6, ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60 },
      signInLockout: { maxFailures: 5, windowMinutes: 15 },
      support: { email: 'support@leader.app' },
    });
    expect(original.demo).toBeUndefined();
    expect(original.createdAt).toBeUndefined();
    expect(original._id).toBeUndefined();
    expect(original.updatedAt).toMatch(/Z$/);
  });

  test('PATCH is partial, nested groups patch key by key, and is audited', async () => {
    const res = await as(sa.token).patch('/settings', { trialDays: 21, otp: { length: 8 }, support: { telegram: '@leader_support' } }).expect(200);
    expect(res.body.trialDays).toBe(21);
    expect(res.body.otp).toEqual({ ...original.otp, length: 8 });
    expect(res.body.support).toEqual({ ...original.support, telegram: '@leader_support' });
    expect(res.body.graceDays).toBe(original.graceDays);
    const audit = await f.models.AuditEvent.findOne({ action: 'platform_settings_changed' }).sort({ occurredAt: -1 });
    expect(audit.category).toBe('platform_configuration');
    expect(audit.changes.map((c) => c.before.value).sort()).toEqual(['otp.length', 'support.telegram', 'trialDays']);

    // A new trial uses the new policy.
    const created = await f
      .api()
      .post(`${API}/tenants`)
      .set(f.auth(sa.token))
      .set(f.idem())
      .send({ displayName: 'فريق السياسة', mainAdminName: 'منى', mainAdminEmail: `${f.uniq('mona')}@x.org` })
      .expect(201);
    const days = (new Date(created.body.subscription.trialEndsAt) - Date.now()) / 86400000;
    expect(Math.round(days)).toBe(21);
  });

  test('PATCH validation: ranges, semver, timezone, empty body', async () => {
    const bad = await as(sa.token).patch('/settings', {
      trialDays: 0,
      breakGlassMinutes: 1,
      minimumClientVersion: 'v2',
      defaultTimezone: 'Nowhere/City',
      otp: { length: 3 },
      support: { email: 'nope' },
    });
    expectError(bad, 422, 'validation');
    expect(Object.keys(bad.body.error.fields)).toEqual(
      expect.arrayContaining(['trialDays', 'breakGlassMinutes', 'minimumClientVersion', 'defaultTimezone', 'otp.length', 'support.email']),
    );
    expectError(await as(sa.token).patch('/settings', {}), 422, 'validation');
    const ok = await as(sa.token).patch('/settings', { minimumClientVersion: '1.0.0' }).expect(200);
    expect(ok.body.minimumClientVersion).toBe('1.0.0');
  });
});

describe('/platform/admins', () => {
  test('list → super admins only', async () => {
    const res = await as(sa.token).get('/admins').expect(200);
    expect(res.body.map((a) => a.id)).toContain(String(sa.account._id));
    expect(res.body.map((a) => a.id)).not.toContain(String(main.account._id));
    expect(Object.keys(res.body[0]).sort()).toEqual(['createdAt', 'email', 'id', 'lastLoginAt', 'mfaEnabled', 'name', 'status']);
  });

  test('create → 201 active super_admin; email in use → 409; weak password → 422', async () => {
    const email = `${f.uniq('ops')}@leader.app`;
    const res = await as(sa.token).post('/admins', { name: 'مشغّل المنصة', email: email.toUpperCase(), password: 'Str0ng!Pass' }).expect(201);
    expect(res.body).toMatchObject({ name: 'مشغّل المنصة', email, status: 'active', mfaEnabled: false, lastLoginAt: null });
    const account = await f.models.Account.findById(res.body.id).select('+passwordHash');
    expect(account).toMatchObject({ role: 'super_admin', saasTenantId: null, emailVerified: true, setupCompleted: true });
    expect(await account.checkPassword('Str0ng!Pass')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    expectError(await as(sa.token).post('/admins', { name: 'مكرر', email, password: 'Str0ng!Pass' }), 409, 'conflict');
    const weak = await as(sa.token).post('/admins', { name: 'ضعيف', email: `${f.uniq('w')}@leader.app`, password: 'short' });
    expectError(weak, 422, 'validation');
    expect(weak.body.error.fields.password).toBeDefined();
  });

  test('suspend revokes sessions; self → 409; reactivate; audit', async () => {
    const other = await f.superAdmin();
    expectError(await as(sa.token).post(`/admins/${other.account._id}/suspend`, {}), 422, 'validation');
    const res = await as(sa.token).post(`/admins/${other.account._id}/suspend`, { reason: 'انتهاء التكليف' }).expect(200);
    expect(res.body.status).toBe('suspended');
    const denied = await as(other.token).get('/admins');
    expectError(denied, 401, 'authentication_expired');
    expectError(await as(sa.token).post(`/admins/${other.account._id}/suspend`, { reason: 'مرة ثانية' }), 409, 'conflict');
    expectError(await as(sa.token).post(`/admins/${sa.account._id}/suspend`, { reason: 'نفسي' }), 409, 'conflict');

    const back = await as(sa.token).post(`/admins/${other.account._id}/reactivate`, {}).expect(200);
    expect(back.body.status).toBe('active');
    expectError(await as(sa.token).post(`/admins/${other.account._id}/reactivate`, {}), 409, 'conflict');
    expectError(await as(sa.token).post(`/admins/${main.account._id}/suspend`, { reason: 'ليس مديراً للمنصة' }), 404, 'not_found');
    const actions = await f.models.AuditEvent.find({ 'target.id': String(other.account._id) }).distinct('action');
    expect(actions.sort()).toEqual(['platform_admin_reactivated', 'platform_admin_suspended']);
  });
});

describe('/platform/accounts', () => {
  test('search, filters, tenant name and keyset paging', async () => {
    const tok = f.uniq('acct');
    const a1 = await f.createAccount({ email: `${tok}.one@test.leader`, name: 'حساب أول' });
    const a2 = await f.createAccount({ email: `${tok}.two@test.leader`, name: 'حساب ثان', status: 'suspended' });
    const a3 = await f.createAccount({ email: `${tok}.three@test.leader`, name: 'حساب ثالث' });

    const all = await as(sa.token).get(`/accounts?search=${tok.toUpperCase()}`).expect(200);
    expect(all.body.items.map((a) => a.id)).toEqual([a3, a2, a1].map((a) => String(a._id)));
    expect(all.body.nextCursor).toBeNull();
    expect(Object.keys(all.body.items[0]).sort()).toEqual(
      ['createdAt', 'email', 'emailVerified', 'id', 'lastLoginAt', 'methods', 'name', 'role', 'saasTenantId', 'status', 'tenantName'].sort(),
    );

    const p1 = await as(sa.token).get(`/accounts?search=${tok}&limit=2`).expect(200);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await as(sa.token).get(`/accounts?search=${tok}&limit=2&cursor=${p1.body.nextCursor}`).expect(200);
    expect(p2.body.items.map((a) => a.id)).toEqual([String(a1._id)]);
    expect(p2.body.nextCursor).toBeNull();

    const suspended = await as(sa.token).get(`/accounts?search=${tok}&status=suspended`).expect(200);
    expect(suspended.body.items.map((a) => a.id)).toEqual([String(a2._id)]);

    const byTenant = await as(sa.token).get(`/accounts?tenantId=${tenant._id}&role=main_admin`).expect(200);
    expect(byTenant.body.items).toHaveLength(1);
    expect(byTenant.body.items[0]).toMatchObject({ id: String(main.account._id), role: 'main_admin', tenantName: tenant.displayName, saasTenantId: String(tenant._id) });

    expectError(await as(sa.token).get('/accounts?role=wizard'), 422, 'validation');
    expectError(await as(sa.token).get('/accounts?cursor=zzz'), 422, 'validation');
  });

  test('detail carries activeSessions; sign-out-all revokes them', async () => {
    const target = await f.simpleAdmin(tenant);
    await f.login(target.account);
    const res = await as(sa.token).get(`/accounts/${target.account._id}`).expect(200);
    expect(res.body).toMatchObject({ id: String(target.account._id), role: 'admin', tenantName: tenant.displayName, activeSessions: 2 });

    const out = await as(sa.token).post(`/accounts/${target.account._id}/sign-out-all`, {}).expect(200);
    expect(out.body).toEqual({ revoked: 2 });
    expect((await as(sa.token).get(`/accounts/${target.account._id}`).expect(200)).body.activeSessions).toBe(0);
    expectError(await as(sa.token).get('/accounts/u_nope'), 404, 'not_found');
    expectError(await as(sa.token).post('/accounts/u_nope/sign-out-all', {}), 404, 'not_found');
  });
});
