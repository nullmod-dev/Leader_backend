/**
 * Folder 12 — Super Admin insight reads: overview, health, security, audit,
 * reports, analytics and background jobs. Read-only except the job runs
 * (jobs are idempotent and are what the server's interval runner does anyway).
 *
 * Collection variables written here:
 *   auditNextCursor · auditEventId · reportSubsCursor · reportUsageCursor
 * A page-2 request whose cursor was not issued (small dataset) sends an empty
 * cursor, which the API reads as page one — the shape checks still hold.
 */
const clearIfAbsent = (variable, expr) => `if (!(${expr})) pm.collectionVariables.set(${JSON.stringify(variable)}, "")`;

const reportEnvelope = (type) => [
  `pm.expect(json.type).to.eql("${type}")`,
  'pm.expect(json.generatedAt).to.match(/Z$/)',
  'pm.expect(json.snapshotId).to.be.a("string")',
  'pm.expect(json.summary.tenantCount).to.be.a("number")',
  'pm.expect(json.rows.items).to.be.an("array")',
  'pm.expect(json.rows).to.have.property("nextCursor")',
  'json.rows.items.forEach(r => pm.expect(Object.keys(r.tenant)).to.eql(["id","displayName"]))',
  'pm.expect(JSON.stringify(json)).to.not.match(/MTM-[0-9A-Z]{4}-[0-9A-Z]{4}/)',
];
const sumIs = (buckets, total = 'json.summary.tenantCount') => `pm.expect(${buckets}.reduce((n, b) => n + b.count, 0)).to.eql(${total})`;

module.exports = {
  name: 'Platform · Insights',
  order: 12,
  description:
    'Super Admin dashboard reads: `/platform/overview`, `/platform/health`, `/platform/security-alerts`, the audit log ' +
    '(`/platform/audit`), the four reports (`/platform/reports/*`), analytics charts (`/platform/analytics/*`) and background ' +
    'jobs (`/platform/jobs`). See docs/api/platform-insights.md for every metric definition.',
  items: [
    // ---- overview / health / security ----------------------------------------------------
    {
      name: 'Overview',
      method: 'GET',
      path: '/platform/overview',
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.tenants).to.have.all.keys("total","activeSubscriptions","activeTrials","gracePeriod","suspended","deletionPending")',
        'pm.expect(json.tenants.total).to.be.at.least(1)',
        'pm.expect(json.demos.simple + json.demos.full).to.eql(json.demos.active)',
        'pm.expect(json.demos.expiringSoon).to.be.at.most(json.demos.active)',
        'pm.expect(json.health.map(s => s.id)).to.eql(["identity","background_jobs","files"])',
        'json.attention.forEach(a => pm.expect(["info","warning","critical"]).to.include(a.severity))',
        'pm.expect(json.recentActivity.length).to.be.at.most(10)',
        'pm.expect(json.usage.storageUsedBytes).to.be.a("number")',
      ],
    },
    {
      name: 'Overview — tenant session is refused (403)',
      method: 'GET',
      path: '/platform/overview',
      auth: 'main',
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Health signals',
      method: 'GET',
      path: '/platform/health',
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.isPartial).to.eql(false)',
        'pm.expect(json.signals.map(s => s.id)).to.eql(["identity","background_jobs","files"])',
        'json.signals.forEach(s => pm.expect(["healthy","degraded","unavailable","unknown"]).to.include(s.status))',
      ],
    },
    {
      name: 'Security alerts',
      method: 'GET',
      path: '/platform/security-alerts',
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.alerts).to.be.an("array")',
        'json.alerts.forEach(a => { pm.expect(a.category).to.eql("authentication"); pm.expect(["info","warning","critical"]).to.include(a.severity); })',
        'pm.expect(JSON.stringify(json)).to.not.include("@")',
      ],
    },

    // ---- audit -------------------------------------------------------------------------------
    {
      name: 'Audit — first page (limit 2)',
      method: 'GET',
      path: '/platform/audit',
      auth: 'platform',
      query: { limit: 2 },
      expect: 200,
      tests: [
        'pm.expect(json.items).to.be.an("array")',
        'pm.expect(json.items.length).to.be.at.most(2)',
        'json.items.forEach(e => pm.expect(e).to.include.keys("id","occurredAt","actor","action","category"))',
        clearIfAbsent('auditNextCursor', 'json.nextCursor'),
      ],
      save: { auditNextCursor: 'json.nextCursor', auditEventId: 'json.items[0] && json.items[0].id' },
    },
    {
      name: 'Audit — page 2 via nextCursor',
      method: 'GET',
      path: '/platform/audit',
      auth: 'platform',
      query: { limit: 2, cursor: '{{auditNextCursor}}' },
      expect: 200,
      tests: ['pm.expect(json.items).to.be.an("array")', 'pm.expect(json).to.have.property("nextCursor")'],
    },
    {
      name: 'Audit — filter by category + search',
      method: 'GET',
      path: '/platform/audit',
      auth: 'platform',
      query: { category: 'tenant_management', search: 'فريق' },
      expect: 200,
      tests: ['json.items.forEach(e => pm.expect(e.category).to.eql("tenant_management"))'],
    },
    {
      name: 'Audit — one event',
      method: 'GET',
      path: '/platform/audit/{{auditEventId}}',
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json.id).to.eql(pm.collectionVariables.get("auditEventId"))'],
    },
    {
      name: 'Audit — invalid cursor (422)',
      method: 'GET',
      path: '/platform/audit',
      auth: 'platform',
      query: { cursor: 'not-a-cursor' },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },

    // ---- reports -------------------------------------------------------------------------------
    {
      name: 'Report — subscriptions (limit 3)',
      method: 'GET',
      path: '/platform/reports/subscriptions',
      auth: 'platform',
      query: { limit: 3 },
      expect: 200,
      tests: [
        ...reportEnvelope('subscriptions'),
        sumIs('json.summary.byStatus'),
        sumIs('json.summary.byLifecycle'),
        sumIs('json.summary.byPlan'),
        clearIfAbsent('reportSubsCursor', 'json.rows.nextCursor'),
      ],
      save: { reportSubsCursor: 'json.rows.nextCursor' },
    },
    {
      name: 'Report — subscriptions page 2 (same snapshot)',
      method: 'GET',
      path: '/platform/reports/subscriptions',
      auth: 'platform',
      query: { limit: 3, cursor: '{{reportSubsCursor}}' },
      expect: 200,
      tests: [...reportEnvelope('subscriptions')],
    },
    {
      name: 'Report — subscriptions, trials due before a date',
      method: 'GET',
      path: '/platform/reports/subscriptions',
      auth: 'platform',
      query: { status: 'trial,grace', lifecycle: 'active', dueBefore: '2030-01-01T00:00:00Z' },
      expect: 200,
      tests: ['json.rows.items.forEach(r => pm.expect(["trial","grace"]).to.include(r.subscriptionStatus))'],
    },
    {
      name: 'Report — usage limits (limit 3)',
      method: 'GET',
      path: '/platform/reports/usage-limits',
      auth: 'platform',
      query: { limit: 3 },
      expect: 200,
      tests: [
        ...reportEnvelope('usage_limits'),
        'json.summary.byKey.forEach(k => pm.expect(k.bands.reduce((n, b) => n + b.count, 0)).to.eql(json.summary.tenantCount))',
        'json.rows.items.forEach(r => pm.expect(r.cells.length).to.eql(6))',
        clearIfAbsent('reportUsageCursor', 'json.rows.nextCursor'),
      ],
      save: { reportUsageCursor: 'json.rows.nextCursor' },
    },
    {
      name: 'Report — usage limits page 2',
      method: 'GET',
      path: '/platform/reports/usage-limits',
      auth: 'platform',
      query: { limit: 3, cursor: '{{reportUsageCursor}}' },
      expect: 200,
      tests: [...reportEnvelope('usage_limits')],
    },
    {
      name: 'Report — feature availability',
      method: 'GET',
      path: '/platform/reports/feature-availability',
      auth: 'platform',
      expect: 200,
      tests: [
        ...reportEnvelope('feature_availability'),
        'json.summary.byFeature.forEach(x => pm.expect(x.states.reduce((n, b) => n + b.count, 0)).to.eql(json.summary.tenantCount))',
      ],
    },
    {
      name: 'Report — platform activity (last 30 days)',
      method: 'GET',
      path: '/platform/reports/platform-activity',
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.type).to.eql("platform_activity")',
        'pm.expect(json.evidenceAvailableFrom).to.eql(null)',
        'pm.expect(new Date(json.range.before) - new Date(json.range.from)).to.eql(30 * 86400000)',
        'pm.expect(json.byAction.map(b => b.key)).to.include("tenant_registered")',
      ],
    },
    {
      name: 'Report — platform activity range too large (422)',
      method: 'GET',
      path: '/platform/reports/platform-activity',
      auth: 'platform',
      query: { from: '2024-01-01T00:00:00Z', before: '2026-01-01T00:00:00Z' },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("report_range_too_large")'],
    },
    {
      name: 'Report — unknown parameter (422)',
      method: 'GET',
      path: '/platform/reports/subscriptions',
      auth: 'platform',
      query: { sort: 'name' },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },

    // ---- analytics -------------------------------------------------------------------------------
    {
      name: 'Analytics — summary (30 days)',
      method: 'GET',
      path: '/platform/analytics/summary',
      auth: 'platform',
      query: { period: '30d' },
      expect: 200,
      tests: [
        'pm.expect(json.kpis).to.have.all.keys("tenants","subscriptions","accounts","signIns","demos","revenue","storageUsedBytes")',
        'pm.expect(json.kpis.revenue.currency).to.eql("USD")',
        'pm.expect(json.distributions.lifecycle.reduce((n, b) => n + b.count, 0)).to.eql(json.kpis.tenants.total)',
        'pm.expect(json.distributions.plans.reduce((n, b) => n + b.count, 0)).to.eql(json.kpis.tenants.total)',
      ],
    },
    {
      name: 'Analytics — growth by week',
      method: 'GET',
      path: '/platform/analytics/growth',
      auth: 'platform',
      query: { granularity: 'week' },
      expect: 200,
      tests: [
        'pm.expect(json.granularity).to.eql("week")',
        'pm.expect(json.series.length).to.be.within(12, 13)',
        'json.series.forEach(s => pm.expect(s).to.have.all.keys("bucket","tenantsCreated","accountsCreated","signIns","demoStarts","revenue"))',
      ],
    },
    {
      name: 'Analytics — tenants by members',
      method: 'GET',
      path: '/platform/analytics/tenants',
      auth: 'platform',
      query: { sort: 'members', limit: 5 },
      expect: 200,
      tests: [
        'pm.expect(json.items.length).to.be.at.most(5)',
        'json.items.forEach(t => pm.expect(t.counts).to.have.all.keys("detachments","members","workshops","admins"))',
      ],
    },
    {
      name: 'Analytics — one tenant (saas_hilal)',
      method: 'GET',
      path: '/platform/analytics/tenants/saas_hilal',
      auth: 'platform',
      query: { period: '30d' },
      expect: 200,
      tests: [
        'pm.expect(json.tenant.id).to.eql("saas_hilal")',
        'pm.expect(json.counts).to.have.all.keys("detachmentGroups","detachments","members","workshops","admins","announcements")',
        'pm.expect(json.limits.length).to.eql(6)',
        'pm.expect(json.statusHistory.length).to.be.at.most(20)',
      ],
    },

    // ---- jobs -----------------------------------------------------------------------------------------
    {
      name: 'Jobs — list',
      method: 'GET',
      path: '/platform/jobs',
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.map(j => j.name)).to.include("expire-invitations")',
        'json.forEach(j => pm.expect(j).to.have.all.keys("name","description","lastRunAt","lastSuccessAt","lastStatus","lastError","runs","lastAffected"))',
      ],
    },
    {
      name: 'Jobs — run expire-invitations',
      method: 'POST',
      path: '/platform/jobs/expire-invitations/run',
      auth: 'platform',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.name).to.eql("expire-invitations")', 'pm.expect(json.status).to.eql("ok")', 'pm.expect(json.affected).to.be.a("number")'],
    },
    {
      name: 'Jobs — run all',
      method: 'POST',
      path: '/platform/jobs/run',
      auth: 'platform',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.results).to.be.an("array")', 'json.results.forEach(r => pm.expect(r).to.have.property("status"))'],
    },
  ],
};
