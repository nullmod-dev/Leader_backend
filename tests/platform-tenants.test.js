/**
 * /platform/tenants — registration, list/search/paging, detail, status history,
 * Team Code suggestion, and the platform guard on every control-plane family.
 */
const f = require('./helpers/factory');

const BASE = '/api/v1/platform/tenants';
const DAY = 86400000;
const CODE_RE = /^MTM-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

let sa;

beforeAll(async () => {
  await f.ensurePlans();
  sa = await f.superAdmin();
});

const near = (value, expected, tolerance = 60000) => Math.abs(new Date(value).getTime() - expected) < tolerance;

const body = (overrides = {}) => ({
  displayName: `فريق الشمال الطبي ${f.uniq()}`,
  mainAdminName: 'أمل السبيعي',
  mainAdminEmail: `${f.uniq('amal')}@shamal.org`,
  ...overrides,
});

const create = (payload, key) =>
  f
    .api()
    .post(BASE)
    .set(f.auth(sa.token))
    .set(key ? { 'Idempotency-Key': key } : f.idem())
    .send(payload);

describe('platform guard', () => {
  let main;
  let simple;
  beforeAll(async () => {
    const t = await f.tenantWithMainAdmin();
    main = t.main;
    simple = await f.simpleAdmin(t.tenant);
  });

  const families = [
    ['get', '/api/v1/platform/tenants'],
    ['get', '/api/v1/platform/tenants/suggest-team-code'],
    ['get', '/api/v1/platform/tenants/saas_x/subscription'],
    ['get', '/api/v1/platform/tenants/saas_x/features'],
    ['get', '/api/v1/platform/tenants/saas_x/main-admin'],
    ['post', '/api/v1/platform/tenants/saas_x/lifecycle/suspend'],
    ['post', '/api/v1/platform/tenants/saas_x/subscription/activate'],
    ['get', '/api/v1/platform/plans'],
    ['get', '/api/v1/platform/settings'],
    ['patch', '/api/v1/platform/settings'],
    ['get', '/api/v1/platform/admins'],
    ['get', '/api/v1/platform/accounts'],
  ];

  test.each(families)('%s %s → 403 not_permitted for a Main Admin', async (method, path) => {
    const res = await f.api()[method](path).set(f.auth(main.token)).set(f.idem()).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_permitted');
  });

  test('a Simple Admin is refused too, and no bearer is 401', async () => {
    const res = await f.api().post(BASE).set(f.auth(simple.token)).set(f.idem()).send(body());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_permitted');
    const anon = await f.api().get(BASE);
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('authentication_expired');
  });
});

describe('POST /platform/tenants', () => {
  test('registers an active tenant on trial with a pending Main Admin seat', async () => {
    const payload = body({ mainAdminEmail: `  ${f.uniq('Amal')}@Shamal.ORG ` });
    const res = await create(payload).expect(201);
    const t = res.body;
    expect(t.id).toMatch(/^saas_/);
    expect(t.displayName).toBe(payload.displayName);
    expect(t.teamCode).toMatch(CODE_RE);
    expect(t.timezone).toBe('Asia/Damascus');
    expect(t.lifecycle).toEqual({ status: 'active', version: 1 });
    expect(t.subscription).toMatchObject({ status: 'trial', planId: null, version: 1, renewsAt: null, graceEndsAt: null, limitOverrides: {} });
    expect(near(t.subscription.trialEndsAt, Date.now() + 14 * DAY)).toBe(true);
    expect(t.mainAdmin).toEqual({ name: 'أمل السبيعي', email: payload.mainAdminEmail.trim().toLowerCase(), provisioning: 'pending_setup' });
    expect(t.usage).toEqual({ storageUsedBytes: 0, lastActivityAt: null });
    expect(t.counts).toEqual({ detachmentGroups: 0, detachments: 0, members: 0, workshops: 0 });
    expect(JSON.stringify(t)).not.toMatch(/password|token|otp/i);

    const doc = await f.models.SaasTenant.findById(t.id);
    expect(doc.features.map((x) => [x.key, x.enabled])).toEqual([
      ['inventory', true],
      ['statistics_reports', false],
      ['workshops', false],
      ['announcements', true],
    ]);
    const account = await f.models.Account.findById(doc.seat.currentAccountId);
    expect(account).toMatchObject({ status: 'pending_setup', provisioned: true, emailVerified: false });
    const az = await f.models.Authorization.findOne({ accountId: String(account._id) });
    expect(az).toMatchObject({ kind: 'initial_seat', tenantId: t.id, status: 'pending', role: 'main_admin' });
    expect(await f.models.DevMail.countDocuments({ to: account.email, kind: 'mainAdminSetup' })).toBe(1);

    const events = await f.models.TenantStatusEvent.find({ tenantId: t.id });
    expect(events.map((e) => e.type).sort()).toEqual(['tenant_created', 'trial_started']);
    const audit = await f.models.AuditEvent.findOne({ action: 'tenant_registered', 'tenant.id': t.id });
    expect(audit).toMatchObject({ category: 'tenant_management', target: { type: 'tenant', id: t.id } });
    expect(audit.actor).toMatchObject({ kind: 'platform_administrator', id: String(sa.account._id) });
  });

  test('accepts a typed Team Code in any spacing/case and stores the canonical form', async () => {
    const res = await create(body({ teamCode: 'mtm 7dqx 4nkr', timezone: 'Asia/Riyadh' })).expect(201);
    expect(res.body.teamCode).toBe('MTM-7DQX-4NKR');
    expect(res.body.timezone).toBe('Asia/Riyadh');
  });

  test('a taken Team Code → 409 tenant_code_conflict', async () => {
    const existing = await f.createTenant();
    const res = await create(body({ teamCode: existing.teamCode.toLowerCase() }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('tenant_code_conflict');
  });

  test('a present but malformed Team Code → 422 validation on teamCode', async () => {
    const res = await create(body({ teamCode: 'MTM-1111-0000' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation');
    expect(res.body.error.fields.teamCode).toBeDefined();
  });

  test('field validation: names, email, timezone', async () => {
    const res = await create({ displayName: '   ', mainAdminName: 'x'.repeat(81), mainAdminEmail: 'not-an-email', timezone: 'Mars/Base' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['displayName', 'mainAdminEmail', 'mainAdminName', 'timezone']);
  });

  test('an email that already belongs to an account → 409 main_admin_identity_unavailable, nothing created', async () => {
    const taken = await f.createAccount();
    const before = await f.models.SaasTenant.countDocuments();
    const payload = body({ mainAdminEmail: taken.email.toUpperCase() });
    const res = await create(payload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('main_admin_identity_unavailable');
    expect(await f.models.SaasTenant.countDocuments()).toBe(before);
    expect(await f.models.SaasTenant.exists({ displayName: payload.displayName })).toBeNull();
  });

  test('Idempotency-Key is required', async () => {
    const res = await f.api().post(BASE).set(f.auth(sa.token)).send(body());
    expect(res.status).toBe(422);
    expect(res.body.error.fields['Idempotency-Key']).toBeDefined();
  });

  test('same key + same body replays; same key + other body → idempotency_conflict', async () => {
    const key = `test-${f.uniq()}`;
    const payload = body();
    const first = await create(payload, key).expect(201);
    const again = await create(payload, key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await f.models.SaasTenant.countDocuments({ displayName: payload.displayName })).toBe(1);
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: first.body.id })).toBe(2);

    const other = await create(body(), key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('idempotency_conflict');
  });
});

describe('GET /platform/tenants (list, search, filter, page)', () => {
  const tok = f.uniq('q').toUpperCase();
  let alpha;
  let beta;
  let gamma;

  beforeAll(async () => {
    alpha = (await create(body({ displayName: `مؤسسة إسعاف ${tok}`, mainAdminName: 'هدى السالم', mainAdminEmail: `huda.${tok.toLowerCase()}@nabd.org` })).expect(201)).body;
    beta = (await create(body({ displayName: `فرق الرحمة ${tok}` })).expect(201)).body;
    gamma = (await create(body({ displayName: `فريق ${tok} الثالث` })).expect(201)).body;
    await f.models.SaasTenant.updateOne({ _id: gamma.id }, { $set: { 'lifecycle.status': 'suspended' } });
  });

  const list = (query) => f.api().get(BASE).query(query).set(f.auth(sa.token));

  test('newest first, filtered by folded search, with total', async () => {
    const res = await list({ search: tok }).expect(200);
    expect(res.body.items.map((t) => t.id)).toEqual([gamma.id, beta.id, alpha.id]);
    expect(res.body.total).toBe(3);
    expect(res.body.nextCursor).toBeNull();
  });

  test('Arabic folding: hamza-alef and ta-marbuta variants match', async () => {
    const a = await list({ search: `اسعاف ${tok}` }).expect(200);
    expect(a.body.items.map((t) => t.id)).toEqual([alpha.id]);
    const b = await list({ search: `الرحمه ${tok}` }).expect(200);
    expect(b.body.items.map((t) => t.id)).toEqual([beta.id]);
  });

  test('matches the Main Admin name/email and the Team Code in any form', async () => {
    const byEmail = await list({ search: `HUDA.${tok}` }).expect(200);
    expect(byEmail.body.items.map((t) => t.id)).toEqual([alpha.id]);
    const byCode = await list({ search: beta.teamCode.toLowerCase().replace(/-/g, ' ') }).expect(200);
    expect(byCode.body.items.map((t) => t.id)).toEqual([beta.id]);
    const byCompact = await list({ search: beta.teamCode.slice(4).replace('-', '') }).expect(200);
    expect(byCompact.body.items.map((t) => t.id)).toContain(beta.id);
  });

  test('status filter uses the list projection (lifecycle wins over subscription)', async () => {
    const suspended = await list({ search: tok, status: 'suspended' }).expect(200);
    expect(suspended.body.items.map((t) => t.id)).toEqual([gamma.id]);
    const trial = await list({ search: tok, status: 'trial' }).expect(200);
    expect(trial.body.items.map((t) => t.id)).toEqual([beta.id, alpha.id]);
    expect(trial.body.total).toBe(2);
  });

  test('opaque cursor pages without duplicates or gaps', async () => {
    const p1 = await list({ search: tok, limit: 2 }).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.total).toBe(3);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await list({ search: tok, limit: 2, cursor: p1.body.nextCursor }).expect(200);
    expect(p2.body.items.map((t) => t.id)).toEqual([alpha.id]);
    expect(p2.body.nextCursor).toBeNull();
  });

  test('bad limit / status / cursor → 422 validation', async () => {
    for (const q of [{ limit: 0 }, { limit: 101 }, { status: 'deleted' }, { cursor: 'garbage!!' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await list(q);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation');
    }
  });
});

describe('GET /platform/tenants/:tenantId', () => {
  test('returns the record with platform counts (archived/inactive excluded)', async () => {
    const { tenant } = await f.tenantWithMainAdmin({ usage: { storageUsedBytes: 1024, storageAllowanceBytes: 4096, lastActivityAt: new Date() } });
    const g = await f.group(tenant);
    const d1 = await f.detachment(tenant, g);
    await f.detachment(tenant, g, { status: 'archived' });
    await f.member(tenant, d1);
    await f.member(tenant, d1, { active: false });
    await f.workshop(tenant);
    await f.workshop(tenant, { archived: true });

    const res = await f.api().get(`${BASE}/${tenant._id}`).set(f.auth(sa.token)).expect(200);
    expect(res.body.counts).toEqual({ detachmentGroups: 1, detachments: 1, members: 1, workshops: 1 });
    expect(res.body.mainAdmin).toMatchObject({ name: 'سلمى الحارثي', provisioning: 'active' });
    expect(res.body.subscription).toMatchObject({ status: 'active', planId: 'mtm_standard', trialEndsAt: null });
    expect(res.body.usage).toMatchObject({ storageUsedBytes: 1024, storageAllowanceBytes: 4096 });
    expect(res.body.usage.lastActivityAt).toMatch(/Z$/);
  });

  test('unknown id → 404 not_found', async () => {
    const res = await f.api().get(`${BASE}/saas_nope`).set(f.auth(sa.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('status history + Team Code suggestion', () => {
  test('history is newest first with {id, type, occurredAt, note}', async () => {
    const t = (await create(body()).expect(201)).body;
    const res = await f.api().get(`${BASE}/${t.id}/status-history`).set(f.auth(sa.token)).expect(200);
    expect(res.body.map((e) => e.type)).toEqual(['trial_started', 'tenant_created']);
    expect(Object.keys(res.body[0]).sort()).toEqual(['id', 'note', 'occurredAt', 'type']);
    expect(res.body[0].note).toBeNull();
  });

  test('history of an unknown tenant → 404 not_found', async () => {
    const res = await f.api().get(`${BASE}/saas_nope/status-history`).set(f.auth(sa.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  test('suggest-team-code answers a canonical, unused code', async () => {
    const res = await f.api().get(`${BASE}/suggest-team-code`).set(f.auth(sa.token)).expect(200);
    expect(res.body.teamCode).toMatch(CODE_RE);
    expect(await f.models.SaasTenant.exists({ teamCode: res.body.teamCode })).toBeNull();
  });
});
