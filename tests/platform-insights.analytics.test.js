/**
 * Platform insights — GET /platform/analytics/{summary,growth,tenants,tenants/:id}.
 */
const f = require('./helpers/factory');

const { SaasTenant, Account, Session, DemoSession, BillingOrder, Announcement, TenantStatusEvent } = f.models;
const DAY = 86400000;
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * DAY);

let platform;
let main;
let simple;
const a = {};

const backdate = (Model, id, field, date) => Model.collection.updateOne({ _id: id }, { $set: { [field]: date } });
const get = (path, query = {}) => f.api().get(`/api/v1/platform/analytics${path}`).query(query).set(f.auth(platform.token));

const order = (tenant, overrides) =>
  BillingOrder.create({
    tenantId: String(tenant._id),
    accountId: 'u_payer',
    billingOptionId: 'monthly',
    months: 1,
    basePrice: { amount: 600, currency: 'USD' },
    finalPrice: { amount: 600, currency: 'USD' },
    ...overrides,
  });

beforeAll(async () => {
  platform = await f.superAdmin();

  a.a1 = await f.createTenant({ displayName: 'فريق النشاط', usage: { storageUsedBytes: 100, lastActivityAt: ago(1) } });
  a.a2 = await f.createTenant({
    displayName: 'فريق التجربة',
    subscription: { status: 'trial', planId: null, trialEndsAt: new Date(NOW + 5 * DAY) },
    usage: { storageUsedBytes: 300 },
    features: ['inventory', 'statistics_reports', 'workshops', 'announcements'].map((key) => ({ key, enabled: key !== 'inventory' })),
  });
  a.a3 = await f.createTenant({
    displayName: 'فريق قديم',
    subscription: { status: 'grace', planId: 'mtm_core' },
    lifecycle: { status: 'suspended' },
    usage: { lastActivityAt: ago(50) },
  });
  a.deleted = await f.createTenant({ displayName: 'فريق محذوف', lifecycle: { status: 'deleted' }, usage: { storageUsedBytes: 5000 } });
  await backdate(SaasTenant, a.a1._id, 'createdAt', ago(2));
  await backdate(SaasTenant, a.a2._id, 'createdAt', ago(20));
  await backdate(SaasTenant, a.a3._id, 'createdAt', ago(100));
  await backdate(SaasTenant, a.deleted._id, 'createdAt', ago(1));

  // Accounts + sessions: platform (1 session), main (1), revoked simple (1),
  // an old unlinked identity, a demo identity (never counted), an onboarding
  // session and an old full session (neither in range).
  main = await f.mainAdmin(a.a1);
  simple = await f.simpleAdmin(a.a1, undefined, { status: 'revoked' });
  const unlinked = await f.createAccount({ role: null });
  await backdate(Account, unlinked._id, 'createdAt', ago(40));
  await f.createAccount({ role: 'customer_demo' });
  await f.login(unlinked, 'onboarding');
  const old = await f.login(unlinked, 'full');
  await backdate(Session, old.session._id, 'createdAt', ago(40));

  // Tenant a1 operational counts (counts only ever leave).
  const det = await f.detachment(a.a1);
  await f.member(a.a1, det, { name: 'اسم متطوع سري' });
  await f.member(a.a1, det);
  await f.member(a.a1, det, { active: false });
  await f.workshop(a.a1);
  await f.workshop(a.a1, { archived: true });
  await Announcement.create({
    tenantId: String(a.a1._id),
    text: 'إعلان للاختبار',
    detachmentIds: [String(det._id)],
    publishedAt: new Date(),
    expiresAt: new Date(NOW + DAY),
  });
  const det2 = await f.detachment(a.a2);
  await f.member(a.a2, det2);

  // Demos and billing.
  await DemoSession.create({ accountId: 'u_d1', demoWorkspaceId: 'ws1', startedAt: ago(1), expiresAt: new Date(NOW + 3600000), policyRevision: 1 });
  await DemoSession.create({ accountId: 'u_d2', demoWorkspaceId: 'ws2', startedAt: ago(40), expiresAt: ago(39), status: 'expired', policyRevision: 1 });
  await order(a.a1, { status: 'paid', paidAt: ago(3) });
  await order(a.a1, { status: 'paid', paidAt: ago(40), finalPrice: { amount: 1400, currency: 'USD' } });
  await order(a.a1, { status: 'pending_payment' });
  await order(a.a1, { status: 'cancelled', cancelledAt: ago(2) });

  for (let i = 0; i < 22; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await TenantStatusEvent.create({ tenantId: String(a.a1._id), type: i % 2 ? 'plan_changed' : 'trial_extended', occurredAt: ago(30 - i) });
  }
});

describe('GET /platform/analytics/summary', () => {
  test('KPIs over the last 30 days', async () => {
    const { body } = await get('/summary', { period: '30d' }).expect(200);
    expect(Date.parse(body.range.before) - Date.parse(body.range.from)).toBe(30 * DAY);
    expect(body.kpis).toEqual({
      tenants: { total: 3, newInRange: 3, active: 1 },
      subscriptions: { trial: 1, active: 1, grace: 1, inactive: 0 },
      accounts: { total: 4, tenantAdmins: 1, superAdmins: 1, newInRange: 3 },
      signIns: 3,
      demos: { startedInRange: 1, active: 1 },
      revenue: { amount: 600, currency: 'USD' },
      storageUsedBytes: 400,
    });
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  test('distributions sum to the tenant total', async () => {
    const { body } = await get('/summary').expect(200);
    const d = body.distributions;
    expect(d.lifecycle).toEqual([
      { key: 'active', count: 2 },
      { key: 'suspended', count: 1 },
      { key: 'deletion_pending', count: 0 },
    ]);
    expect(d.subscriptionStatus).toEqual([
      { key: 'trial', count: 1 },
      { key: 'active', count: 1 },
      { key: 'grace', count: 1 },
      { key: 'inactive', count: 0 },
    ]);
    expect(d.plans).toEqual([
      { planId: 'mtm_core', name: 'ليدر الأساسية', count: 1 },
      { planId: 'mtm_standard', name: 'ليدر القياسية', count: 1 },
      { planId: 'mtm_advanced', name: 'ليدر المتقدمة', count: 0 },
      { planId: null, name: null, count: 1 },
    ]);
    expect(d.features.find((x) => x.key === 'inventory')).toEqual({ key: 'inventory', enabled: 2, disabled: 1 });
    expect(d.features.find((x) => x.key === 'workshops')).toEqual({ key: 'workshops', enabled: 3, disabled: 0 });
  });

  test('a short explicit range narrows the in-range KPIs', async () => {
    const { body } = await get('/summary', { period: '7d' }).expect(200);
    expect(body.kpis.tenants.newInRange).toBe(2);
    expect(body.kpis.revenue.amount).toBe(600);
    const narrow = (await get('/summary', { from: ago(10).toISOString(), before: ago(5).toISOString() }).expect(200)).body;
    expect(narrow.kpis.revenue.amount).toBe(0);
    expect(narrow.kpis.signIns).toBe(0);
  });

  test('validation: bad period, from ≥ before', async () => {
    expect((await get('/summary', { period: '2d' }).expect(422)).body.error.code).toBe('validation');
    await get('/summary', { from: ago(1).toISOString(), before: ago(2).toISOString() }).expect(422);
  });
});

describe('GET /platform/analytics/growth', () => {
  beforeAll(async () => {
    // Fixtures in March 2025 (2025-03-01 is a Saturday). The tenant is deleted
    // so it never touches the current-state KPIs; growth still counts it.
    const t = await f.createTenant({ lifecycle: { status: 'deleted' } });
    await backdate(SaasTenant, t._id, 'createdAt', new Date('2025-03-02T10:00:00Z'));
    const acc = await f.createAccount({ role: 'customer_demo' });
    const person = await f.createAccount({ role: null, status: 'revoked' });
    await backdate(Account, person._id, 'createdAt', new Date('2025-03-02T11:00:00Z'));
    const s1 = await f.login(acc);
    const s2 = await f.login(acc);
    const edge = await f.login(acc);
    const early = await f.login(acc);
    await backdate(Session, s1.session._id, 'createdAt', new Date('2025-03-04T09:00:00Z'));
    await backdate(Session, s2.session._id, 'createdAt', new Date('2025-03-04T23:59:59Z'));
    await backdate(Session, edge.session._id, 'createdAt', new Date('2025-03-06T00:00:00Z'));
    await backdate(Session, early.session._id, 'createdAt', new Date('2025-02-28T23:59:59Z'));
    await DemoSession.create({ accountId: 'u_g', demoWorkspaceId: 'wsg', startedAt: new Date('2025-03-04T12:00:00Z'), expiresAt: new Date('2025-03-04T13:00:00Z'), status: 'expired', policyRevision: 1 });
    await order(t, { status: 'paid', paidAt: new Date('2025-03-02T12:00:00Z'), finalPrice: { amount: 1400, currency: 'USD' } });
  });

  test('daily buckets are zero-filled over [from, before)', async () => {
    const { body } = await get('/growth', { from: '2025-03-01T00:00:00Z', before: '2025-03-06T00:00:00Z' }).expect(200);
    expect(body.granularity).toBe('day');
    expect(body.range).toEqual({ from: '2025-03-01T00:00:00.000Z', before: '2025-03-06T00:00:00.000Z' });
    const zero = { tenantsCreated: 0, accountsCreated: 0, signIns: 0, demoStarts: 0, revenue: 0 };
    expect(body.series).toEqual([
      { bucket: '2025-03-01', ...zero },
      { bucket: '2025-03-02', ...zero, tenantsCreated: 1, accountsCreated: 1, revenue: 1400 },
      { bucket: '2025-03-03', ...zero },
      { bucket: '2025-03-04', ...zero, signIns: 2, demoStarts: 1 },
      { bucket: '2025-03-05', ...zero },
    ]);
  });

  test('weekly buckets start on Saturday; monthly on the 1st', async () => {
    const week = (await get('/growth', { granularity: 'week', from: '2025-03-01T00:00:00Z', before: '2025-03-20T00:00:00Z' }).expect(200)).body;
    expect(week.series.map((s) => s.bucket)).toEqual(['2025-03-01', '2025-03-08', '2025-03-15']);
    expect(week.series[0]).toMatchObject({ tenantsCreated: 1, signIns: 3, demoStarts: 1, revenue: 1400 });

    const month = (await get('/growth', { granularity: 'month', from: '2025-01-15T00:00:00Z', before: '2025-04-01T00:00:00Z' }).expect(200)).body;
    expect(month.series.map((s) => s.bucket)).toEqual(['2025-01-01', '2025-02-01', '2025-03-01']);
    expect(month.series[1].signIns).toBe(1);
    expect(month.series[2]).toMatchObject({ tenantsCreated: 1, accountsCreated: 1, signIns: 3, revenue: 1400 });
  });

  test('default range is the last 30 days by day', async () => {
    const { body } = await get('/growth').expect(200);
    expect(body.series.length).toBeGreaterThanOrEqual(30);
    expect(body.series.length).toBeLessThanOrEqual(31);
    expect(body.series.reduce((n, s) => n + s.tenantsCreated, 0)).toBe(3);
  });

  test('more than 400 buckets, from ≥ before, bad granularity → 422 validation', async () => {
    const big = await get('/growth', { from: '2024-01-01T00:00:00Z', before: '2025-03-01T00:00:00Z' }).expect(422);
    expect(big.body.error.code).toBe('validation');
    await get('/growth', { granularity: 'week', from: '2024-01-01T00:00:00Z', before: '2025-03-01T00:00:00Z' }).expect(200);
    await get('/growth', { from: '2025-03-02T00:00:00Z', before: '2025-03-01T00:00:00Z' }).expect(422);
    await get('/growth', { granularity: 'hour' }).expect(422);
  });
});

describe('GET /platform/analytics/tenants', () => {
  const idsOf = (body) => body.items.map((i) => i.tenantId);

  test('sorts by members, storage and last activity; counts only', async () => {
    const byMembers = (await get('/tenants', { sort: 'members' }).expect(200)).body;
    expect(idsOf(byMembers)).toEqual([a.a1, a.a2, a.a3].map((t) => String(t._id)));
    expect(byMembers.items[0]).toEqual({
      tenantId: String(a.a1._id),
      displayName: 'فريق النشاط',
      lifecycleStatus: 'active',
      subscriptionStatus: 'active',
      planId: 'mtm_standard',
      counts: { detachments: 1, members: 2, workshops: 1, admins: 1 },
      storageUsedBytes: 100,
      lastActivityAt: ago(1).toISOString(),
    });
    expect(idsOf((await get('/tenants', { sort: 'storage' })).body)).toEqual([a.a2, a.a1, a.a3].map((t) => String(t._id)));
    expect(idsOf((await get('/tenants')).body)).toEqual([a.a1, a.a3, a.a2].map((t) => String(t._id)));
    expect((await get('/tenants', { limit: 2 })).body.items).toHaveLength(2);

    const text = JSON.stringify(byMembers);
    expect(text).not.toContain('اسم متطوع سري');
    expect(text).not.toContain(a.a1.teamCode);
    expect(text).not.toContain(String(a.deleted._id));
  });

  test('validation: sort and limit', async () => {
    await get('/tenants', { sort: 'name' }).expect(422);
    await get('/tenants', { limit: 101 }).expect(422);
  });
});

describe('GET /platform/analytics/tenants/:tenantId', () => {
  test('one tenant: counts, activity, limits and the last 20 status events', async () => {
    const { body } = await get(`/tenants/${a.a1._id}`, { period: '30d' }).expect(200);
    expect(body.tenant).toEqual({
      id: String(a.a1._id),
      displayName: 'فريق النشاط',
      lifecycleStatus: 'active',
      subscriptionStatus: 'active',
      planId: 'mtm_standard',
      createdAt: ago(2).toISOString(),
    });
    expect(body.counts).toEqual({ detachmentGroups: 1, detachments: 1, members: 2, workshops: 1, admins: 1, announcements: 1 });
    // main + (revoked) simple admin sessions both belong to this tenant.
    expect(body.activity).toEqual({ signInsInRange: 2, lastActivityAt: ago(1).toISOString() });
    expect(body.limits.map((l) => l.key)).toEqual(['detachment_groups', 'detachments', 'admins', 'members', 'workshops', 'storage_bytes']);
    expect(body.limits.find((l) => l.key === 'members')).toEqual({ key: 'members', overridden: false, planDefault: 300, effective: 300, usage: 2 });
    expect(body.statusHistory).toHaveLength(20);
    const times = body.statusHistory.map((e) => e.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(body.statusHistory[0]).toEqual({ id: expect.any(String), type: 'plan_changed', occurredAt: ago(9).toISOString(), note: null });

    const text = JSON.stringify(body);
    expect(text).not.toContain('اسم متطوع سري');
    expect(text).not.toContain(main.account.email);
    expect(text).not.toContain(simple.account.email);
    expect(text).not.toContain(a.a1.teamCode);
  });

  test('unknown and deleted tenants are 404 not_found', async () => {
    expect((await get('/tenants/saas_nope').expect(404)).body.error.code).toBe('not_found');
    await get(`/tenants/${a.deleted._id}`).expect(404);
  });
});
