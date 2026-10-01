/**
 * Platform insights — GET /platform/overview against a known fixture set,
 * plus the authorization sweep over every insights route.
 */
const f = require('./helpers/factory');
const auditService = require('../services/auditService');

const { SaasTenant, DemoSession, SecuritySignal, JobRun } = f.models;
const HOUR = 3600000;
const DAY = 24 * HOUR;

let platform;
let tenantSession;
const t = {};

beforeAll(async () => {
  platform = await f.superAdmin();
  const now = Date.now();

  // H: the tenant the Main Admin session belongs to (active / active).
  const hilal = await f.tenantWithMainAdmin({ displayName: 'فريق الاختبار' });
  t.H = hilal.tenant;
  tenantSession = hilal.main;

  t.A = await f.createTenant({ displayName: 'فريق أ', usage: { storageUsedBytes: 1000, storageAllowanceBytes: 10000 } });
  t.B = await f.createTenant({
    displayName: 'فريق ب',
    subscription: { status: 'trial', planId: null, trialEndsAt: new Date(now + 2 * DAY) },
    usage: { storageUsedBytes: 500 },
  });
  t.C = await f.createTenant({ displayName: 'فريق ج', subscription: { status: 'trial', planId: null, trialEndsAt: new Date(now + 10 * DAY) } });
  t.D = await f.createTenant({ displayName: 'فريق د', subscription: { status: 'grace', planId: 'mtm_core', graceEndsAt: new Date(now + 5 * DAY) } });
  t.E = await f.createTenant({
    displayName: 'فريق هـ',
    subscription: { status: 'inactive', planId: 'mtm_core' },
    lifecycle: { status: 'suspended', suspension: { suspendedAt: new Date(now - DAY), reason: 'x' } },
  });
  t.F = await f.createTenant({
    displayName: 'فريق و',
    lifecycle: {
      status: 'deletion_pending',
      deletion: { requestedAt: new Date(now - DAY), scheduledFor: new Date(now + 30 * DAY), previousStatus: 'active', reason: 'x' },
    },
  });
  // Deleted tenants never count.
  t.G = await f.createTenant({
    displayName: 'فريق محذوف',
    lifecycle: { status: 'deleted' },
    subscription: { status: 'grace', planId: null },
    usage: { storageUsedBytes: 99999, storageAllowanceBytes: 99999 },
  });

  // Demos: 2 live (one expiring within 24 h), one stale-active, one expired, one terminated.
  const demo = (expiresAt, status = 'active') =>
    DemoSession.create({ accountId: f.uniq('u_demo_'), demoWorkspaceId: f.uniq('ws_'), expiresAt, status, policyRevision: 1 });
  await demo(new Date(now + 2 * HOUR));
  await demo(new Date(now + 3 * DAY));
  await demo(new Date(now - HOUR));
  await demo(new Date(now - HOUR), 'expired');
  await demo(new Date(now + HOUR), 'terminated');

  // One critical security alert (refresh replay on the Main Admin's account).
  await SecuritySignal.create({ kind: 'refresh_replay', accountId: String(tenantSession.account._id) });

  // A failed background job.
  await JobRun.create({ _id: 'expire-invitations', lastRunAt: new Date(now - 60000), lastStatus: 'failed', lastError: 'boom', runs: 1 });

  // Audit: 11 mapped platform events (oldest first) + noise that never shows.
  const base = now - 20 * HOUR;
  const mapped = [
    'tenant_registered',
    'subscription_activated',
    'plan_changed',
    'trial_extended',
    'trial_ended',
    'subscription_moved_to_grace',
    'customer_demo_session_started',
    'customer_demo_session_expired',
    'tenant_registered',
    'plan_changed',
    'customer_demo_session_started',
  ];
  for (let i = 0; i < mapped.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await auditService.record({ action: mapped[i], actor: platform.account, tenant: t.A, occurredAt: new Date(base + i * HOUR) });
  }
  await auditService.record({ action: 'commerce_offer_created', actor: platform.account, occurredAt: new Date(now - 1000) });
  await auditService.record({ action: 'feature_flag_changed', actor: platform.account, tenant: t.A, occurredAt: new Date(now - 500) });
  await auditService.record({ action: 'admin_invitation_created', stream: 'tenant', actor: tenantSession.account, tenant: t.H, occurredAt: new Date(now - 100) });
});

describe('GET /platform/overview', () => {
  let body;
  beforeAll(async () => {
    const res = await f.api().get('/api/v1/platform/overview').set(f.auth(platform.token)).expect(200);
    body = res.body;
  });

  test('tenant counts: commercial and lifecycle axes, deleted excluded', () => {
    expect(body.tenants).toEqual({ total: 7, activeSubscriptions: 3, activeTrials: 2, gracePeriod: 1, suspended: 1, deletionPending: 1 });
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  test('demo counts by server time (simple = active, full = 0)', () => {
    expect(body.demos).toEqual({ active: 2, simple: 2, full: 0, expiringSoon: 1 });
  });

  test('health carries the three signals', () => {
    expect(body.health.map((s) => s.id)).toEqual(['identity', 'background_jobs', 'files']);
    expect(body.health.find((s) => s.id === 'background_jobs').status).toBe('degraded');
  });

  test('attention: deletion, grace, trial, security, health and job items, most severe first', () => {
    const byId = Object.fromEntries(body.attention.map((a) => [a.id, a]));
    const deletion = byId[`attention_deletion_${t.F._id}`];
    expect(deletion).toMatchObject({
      severity: 'warning',
      category: 'tenant_lifecycle',
      target: 'tenants',
      tenantId: String(t.F._id),
      scheduledFor: t.F.lifecycle.deletion.scheduledFor.toISOString(),
    });
    expect(byId.attention_grace).toMatchObject({ severity: 'warning', category: 'subscription', target: 'tenants', title: 'اشتراك واحد في فترة السماح' });
    expect(byId.attention_trials_ending).toMatchObject({ severity: 'info', category: 'trial', target: 'tenants' });
    expect(byId.attention_trials_ending.description).toContain('1');
    const security = body.attention.filter((a) => a.category === 'security');
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({ severity: 'critical', target: 'security' });
    expect(byId.attention_health_background_jobs).toMatchObject({ severity: 'warning', category: 'health', target: 'health' });
    expect(byId['attention_job_expire-invitations']).toMatchObject({ severity: 'warning', category: 'background_job', target: 'operations' });

    const rank = { critical: 3, warning: 2, info: 1 };
    const ranks = body.attention.map((a) => rank[a.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    body.attention.forEach((a) => {
      expect(['info', 'warning', 'critical']).toContain(a.severity);
      expect(Date.parse(a.occurredAt)).not.toBeNaN();
    });
    // A job's raw error text never reaches the overview.
    expect(JSON.stringify(body.attention)).not.toContain('boom');
  });

  test('recent activity: 10 newest mapped platform events, newest first', () => {
    expect(body.recentActivity).toHaveLength(10);
    const types = body.recentActivity.map((r) => r.type);
    expect(types[0]).toBe('demo_started');
    expect(types[1]).toBe('subscription_changed');
    expect(types[2]).toBe('tenant_created');
    expect(types).toContain('demo_expired');
    types.forEach((type) => expect(['tenant_created', 'subscription_changed', 'demo_started', 'demo_expired']).toContain(type));
    const times = body.recentActivity.map((r) => r.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
    body.recentActivity.forEach((r) => expect(r.title).toMatch(/[؀-ۿ]/));
  });

  test('usage sums non-deleted tenants', () => {
    expect(body.usage).toEqual({ storageUsedBytes: 1500, storageAllowanceBytes: 10000 });
  });

  test('never leaks a Team Code or email', () => {
    const text = JSON.stringify(body);
    Object.values(t).forEach((tenant) => expect(text).not.toContain(tenant.teamCode));
    expect(text).not.toContain(tenantSession.account.email);
  });
});

describe('overview on an empty platform', () => {
  test('usage is omitted when no tenant exists', async () => {
    const ids = Object.values(t).map((x) => x._id);
    const docs = await SaasTenant.find({ _id: { $in: ids } }).lean();
    await SaasTenant.deleteMany({ _id: { $in: ids } });
    try {
      const res = await f.api().get('/api/v1/platform/overview').set(f.auth(platform.token)).expect(200);
      expect(res.body.tenants.total).toBe(0);
      expect(res.body.usage).toBeUndefined();
    } finally {
      await SaasTenant.insertMany(docs);
    }
  });
});

describe('authorization — every insights route is super_admin only', () => {
  const routes = [
    ['get', '/api/v1/platform/overview'],
    ['get', '/api/v1/platform/health'],
    ['get', '/api/v1/platform/security-alerts'],
    ['get', '/api/v1/platform/audit'],
    ['get', '/api/v1/platform/audit/audit_x'],
    ['get', '/api/v1/platform/reports/subscriptions'],
    ['get', '/api/v1/platform/reports/usage-limits'],
    ['get', '/api/v1/platform/reports/feature-availability'],
    ['get', '/api/v1/platform/reports/platform-activity'],
    ['get', '/api/v1/platform/analytics/summary'],
    ['get', '/api/v1/platform/analytics/growth'],
    ['get', '/api/v1/platform/analytics/tenants'],
    ['get', '/api/v1/platform/analytics/tenants/saas_x'],
    ['get', '/api/v1/platform/jobs'],
    ['post', '/api/v1/platform/jobs/run'],
    ['post', '/api/v1/platform/jobs/expire-invitations/run'],
  ];

  test.each(routes)('%s %s → 403 not_permitted for a tenant session', async (method, url) => {
    const res = await f.api()[method](url).set(f.auth(tenantSession.token)).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });

  test.each(routes)('%s %s → 401 without a bearer', async (method, url) => {
    const res = await f.api()[method](url).expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });

  test('an unknown /platform path is still 404 (guards are per route)', async () => {
    const res = await f.api().get('/api/v1/platform/definitely-not-here').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
