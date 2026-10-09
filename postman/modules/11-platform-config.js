/**
 * Folder 11 — platform configuration as the seeded Super Admin: plans,
 * settings (patched and RESTORED), platform admins and account lookup.
 * Nothing seeded is left changed: the created plan is deleted, the settings
 * are restored from the values read first, and the new admin is a fresh
 * account.
 */
const P = '/platform';

module.exports = {
  name: 'Platform · Configuration',
  order: 11,
  description:
    'Plans catalogue, platform policy settings, Super Admin accounts and cross-tenant account lookup. ' +
    'See docs/api/platform-configuration.md.',
  items: [
    // ---- plans ---------------------------------------------------------------------------
    {
      name: 'List plans',
      method: 'GET',
      path: `${P}/plans`,
      auth: 'platform',
      expect: 200,
      tests: [
        'pm.expect(json.map(p => p.id)).to.include.members(["mtm_core","mtm_standard","mtm_advanced"])',
        'pm.expect(json[0]).to.have.all.keys("id","name","description","recommended","selectable","defaultLimits")',
      ],
    },
    {
      name: 'Create a plan',
      method: 'POST',
      path: `${P}/plans`,
      auth: 'platform',
      idempotent: true,
      prerequest: ['pm.collectionVariables.set("newPlanId", "pm_pilot_" + Date.now());'],
      body: {
        id: '{{newPlanId}}',
        name: 'ليدر التجريبية',
        description: 'خطة تجريبية مؤقتة.',
        recommended: false,
        selectable: true,
        defaultLimits: { detachment_groups: 3, detachments: 8, admins: 4, members: 120, workshops: 20, storage_bytes: 10737418240 },
      },
      expect: 201,
      tests: ['pm.expect(json.id).to.eql(pm.collectionVariables.get("newPlanId"))', 'pm.expect(json.defaultLimits.members).to.eql(120)'],
    },
    {
      name: 'Create a plan — duplicate id → 409 conflict',
      method: 'POST',
      path: `${P}/plans`,
      auth: 'platform',
      body: {
        id: '{{newPlanId}}',
        name: 'مكررة',
        defaultLimits: { detachment_groups: 1, detachments: 1, admins: 1, members: 1, workshops: 1, storage_bytes: 1 },
      },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    {
      name: 'Create a plan — validation → 422',
      method: 'POST',
      path: `${P}/plans`,
      auth: 'platform',
      body: { id: 'Bad Id', name: 'x', defaultLimits: { members: -1 } },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },
    {
      name: 'Patch the plan (partial)',
      method: 'PATCH',
      path: `${P}/plans/{{newPlanId}}`,
      auth: 'platform',
      body: { selectable: false, defaultLimits: { members: 150 } },
      expect: 200,
      tests: ['pm.expect(json.selectable).to.eql(false)', 'pm.expect(json.defaultLimits.members).to.eql(150)', 'pm.expect(json.defaultLimits.admins).to.eql(4)'],
    },
    {
      name: 'Delete a plan in use → 409 conflict',
      method: 'DELETE',
      path: `${P}/plans/mtm_standard`,
      auth: 'platform',
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    {
      name: 'Delete the new plan',
      method: 'DELETE',
      path: `${P}/plans/{{newPlanId}}`,
      auth: 'platform',
      expect: 204,
    },

    // ---- settings ---------------------------------------------------------------------------
    {
      name: 'Get platform settings (remember originals)',
      method: 'GET',
      path: `${P}/settings`,
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json).to.not.have.property("demo")', 'pm.expect(json.otp).to.have.all.keys("length","ttlMinutes","maxAttempts","resendCooldownSeconds")'],
      save: {
        origTrialDays: 'json.trialDays',
        origGraceDays: 'json.graceDays',
        origOtpLength: 'json.otp.length',
        origSupportTelegram: 'json.support.telegram',
      },
    },
    {
      name: 'Patch settings (trialDays, graceDays, otp.length, support.telegram)',
      method: 'PATCH',
      path: `${P}/settings`,
      auth: 'platform',
      body: { trialDays: 21, graceDays: 10, otp: { length: 8 }, support: { telegram: '@leader_support' } },
      expect: 200,
      tests: ['pm.expect(json.trialDays).to.eql(21)', 'pm.expect(json.otp.length).to.eql(8)', 'pm.expect(json.support.telegram).to.eql("@leader_support")'],
    },
    {
      name: 'Patch settings — validation → 422',
      method: 'PATCH',
      path: `${P}/settings`,
      auth: 'platform',
      body: { trialDays: 0, minimumClientVersion: 'v2', defaultTimezone: 'Nowhere/City' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.all.keys("trialDays","minimumClientVersion","defaultTimezone")'],
    },
    {
      name: 'Restore settings',
      method: 'PATCH',
      path: `${P}/settings`,
      auth: 'platform',
      body: {
        trialDays: '{{origTrialDays}}',
        graceDays: '{{origGraceDays}}',
        otp: { length: '{{origOtpLength}}' },
        support: { telegram: '{{origSupportTelegram}}' },
      },
      expect: 200,
      tests: ['pm.expect(String(json.trialDays)).to.eql(pm.collectionVariables.get("origTrialDays"))'],
    },

    // ---- platform admins ------------------------------------------------------------------------
    {
      name: 'List platform admins',
      method: 'GET',
      path: `${P}/admins`,
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json.map(a => a.email)).to.include("nullmod.dev@gmail.com")'],
    },
    {
      name: 'Create a platform admin',
      method: 'POST',
      path: `${P}/admins`,
      auth: 'platform',
      idempotent: true,
      prerequest: ['pm.collectionVariables.set("newAdminEmail", "ops." + Date.now() + "@leader.example");'],
      body: { name: 'مشغّل المنصة', email: '{{newAdminEmail}}', password: 'Leader@Ops2026' },
      expect: 201,
      tests: ['pm.expect(json.status).to.eql("active")', 'pm.expect(JSON.stringify(json)).to.not.match(/password/i)'],
      save: { newAdminId: 'json.id' },
    },
    {
      name: 'Create a platform admin — weak password → 422',
      method: 'POST',
      path: `${P}/admins`,
      auth: 'platform',
      body: { name: 'ضعيف', email: 'weak.{{$timestamp}}@leader.example', password: 'short' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("password")'],
    },
    {
      name: 'Create a platform admin — email in use → 409',
      method: 'POST',
      path: `${P}/admins`,
      auth: 'platform',
      body: { name: 'مكرر', email: '{{newAdminEmail}}', password: 'Leader@Ops2026' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    {
      name: 'Suspend the new admin',
      method: 'POST',
      path: `${P}/admins/{{newAdminId}}/suspend`,
      auth: 'platform',
      body: { reason: 'انتهاء التكليف' },
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("suspended")'],
    },
    {
      name: 'Reactivate the new admin',
      method: 'POST',
      path: `${P}/admins/{{newAdminId}}/reactivate`,
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("active")'],
    },

    // ---- accounts lookup -----------------------------------------------------------------------
    {
      name: 'Search accounts (email)',
      method: 'GET',
      path: `${P}/accounts`,
      auth: 'platform',
      query: { search: 'pbea4007' },
      expect: 200,
      tests: ['pm.expect(json.items[0].role).to.eql("main_admin")', 'pm.expect(json.items[0].tenantName).to.eql("alwalla")'],
    },
    {
      name: 'Accounts of saas_hilal',
      method: 'GET',
      path: `${P}/accounts`,
      auth: 'platform',
      query: { tenantId: 'saas_hilal', limit: 20 },
      expect: 200,
      tests: ['pm.expect(json.items.every(a => a.saasTenantId === "saas_hilal")).to.eql(true)'],
    },
    {
      name: 'Account detail (new admin)',
      method: 'GET',
      path: `${P}/accounts/{{newAdminId}}`,
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json.role).to.eql("super_admin")', 'pm.expect(json.activeSessions).to.be.a("number")'],
    },
    {
      name: 'Sign the new admin out everywhere',
      method: 'POST',
      path: `${P}/accounts/{{newAdminId}}/sign-out-all`,
      auth: 'platform',
      expect: 200,
      tests: ['pm.expect(json.revoked).to.be.a("number")'],
    },

    // ---- negatives -------------------------------------------------------------------------------
    {
      name: 'Tenant role token → 403 not_permitted (settings)',
      method: 'GET',
      path: `${P}/settings`,
      auth: '{{mainAdminToken}}',
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
  ],
};
