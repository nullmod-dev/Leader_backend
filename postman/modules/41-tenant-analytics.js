/**
 * Tenant analytics — /tenant/analytics/**. docs/api/tenant-analytics.md
 * Read-only; needs the statistics_reports module and stats.view.
 */
module.exports = {
  name: 'Tenant · Analytics',
  order: 41,
  description:
    'Dashboard, one-detachment report, workshops and inventory analytics. Every figure is limited to the detachments where the caller holds stats.view (the Simple Admin sees d_dam_central + d_homs only).',
  items: [
    {
      name: 'Dashboard (Main Admin — every active detachment)',
      method: 'GET',
      path: '/tenant/analytics/dashboard',
      expect: 200,
      tests: [
        'pm.expect(json.range.from).to.match(/^\\d{4}-\\d{2}-\\d{2}$/)',
        'pm.expect(json.kpis.coveragePercent).to.be.within(0, 100)',
        'pm.expect(json.series.coverage).to.have.lengthOf(30)',
        'pm.expect(json.byDetachment).to.be.an("array")',
      ],
      save: { analyticsDetachmentCount: 'json.kpis.detachments' },
    },
    {
      name: 'Dashboard — explicit range',
      method: 'GET',
      path: '/tenant/analytics/dashboard',
      query: { from: '2026-09-01', to: '2026-09-30' },
      expect: 200,
      tests: ['pm.expect(json.range).to.eql({ from: "2026-09-01", to: "2026-09-30" })'],
    },
    {
      name: 'Dashboard — range over 366 days → 422 validation',
      method: 'GET',
      path: '/tenant/analytics/dashboard',
      query: { from: '2024-01-01', to: '2026-01-01' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("range")'],
    },
    {
      name: 'Detachment report — d_dam_central',
      method: 'GET',
      path: '/tenant/analytics/detachments/d_dam_central',
      expect: 200,
      tests: ['pm.expect(json.detachment.id).to.eql("d_dam_central")', 'pm.expect(json.members).to.be.an("array")', 'pm.expect(json.centers).to.be.an("array")'],
    },
    {
      name: 'Workshops analytics',
      method: 'GET',
      path: '/tenant/analytics/workshops',
      expect: 200,
      tests: ['pm.expect(json.byStatus).to.have.all.keys("scheduled","ongoing","done")', 'pm.expect(json.payments).to.have.property("totalCollected")'],
    },
    {
      name: 'Inventory analytics',
      method: 'GET',
      path: '/tenant/analytics/inventory',
      expect: 200,
      tests: ['pm.expect(json.byLevel).to.have.all.keys("ok","low","empty")', 'pm.expect(json.expiring).to.be.an("array")'],
    },
    {
      name: 'Inventory analytics — one detachment',
      method: 'GET',
      path: '/tenant/analytics/inventory',
      query: { detachmentId: 'd_dam_central' },
      expect: 200,
    },
    {
      name: 'Dashboard (Simple Admin — scoped to its detachments)',
      method: 'GET',
      path: '/tenant/analytics/dashboard',
      auth: 'simple',
      expect: 200,
      tests: [
        'json.byDetachment.forEach(function (d) { pm.expect(["d_dam_central","d_homs"]).to.include(d.detachmentId); })',
        'pm.expect(json.kpis.detachments).to.be.at.most(2)',
      ],
    },
    {
      name: 'Detachment report outside the Simple Admin scope → 403',
      method: 'GET',
      path: '/tenant/analytics/detachments/d_coast',
      auth: 'simple',
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
  ],
};
