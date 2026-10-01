/**
 * Tenant administration — /settings and /tenant (organisation, features,
 * Simple Admins, tenant audit). docs/api/tenant-administration.md
 *
 * Leaves the seeded data as it found it: notification prefs are restored, the
 * invitation it creates goes to a random address and is cancelled, and the
 * seeded Simple Admin keeps the sub-admin preset in d_dam_central + d_homs.
 */
const SIMPLE_ADMIN_ID = 'u_demo_simple';
const SIMPLE_ADMIN_DETACHMENTS = ['d_dam_central', 'd_homs'];

/** Refresh `adminRevision` (+ assignable keys) from the management snapshot. */
const readSnapshot = (name) => ({
  name,
  method: 'GET',
  path: '/tenant/simple-admins',
  expect: 200,
  tests: ['pm.expect(json.revision).to.be.a("number")', 'pm.expect(json.accounts).to.be.an("array")'],
  save: { adminRevision: 'json.revision', assignableKeys: 'json.assignableKeys' },
});

module.exports = {
  name: 'Tenant · Administration',
  order: 40,
  description:
    'Notification preferences (any full session), the organisation profile + logo (org.edit), the OrganizationSnapshot, module flags, Simple Admin management (admin.manage) and the tenant audit stream.',
  items: [
    // ---- notification prefs -------------------------------------------------------
    {
      name: 'Notification prefs — read',
      method: 'GET',
      path: '/settings/notifications',
      expect: 200,
      tests: ['pm.expect(json.shiftReminders).to.be.a("boolean")', 'pm.expect(Object.keys(json)).to.have.members(["shiftReminders","stockAlerts","workshopUpdates","joinRequests"])'],
      save: { originalNotificationPrefs: 'json' },
    },
    {
      name: 'Notification prefs — replace',
      method: 'PUT',
      path: '/settings/notifications',
      idempotent: true,
      body: { shiftReminders: false, stockAlerts: true, workshopUpdates: false, joinRequests: true },
      expect: 200,
      tests: ['pm.expect(json.joinRequests).to.eql(true)', 'pm.expect(json.shiftReminders).to.eql(false)'],
    },
    {
      name: 'Notification prefs — a missing flag → 422 validation',
      method: 'PUT',
      path: '/settings/notifications',
      body: { shiftReminders: true },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },
    {
      name: 'Notification prefs — restore',
      method: 'PUT',
      path: '/settings/notifications',
      body: { shiftReminders: true, stockAlerts: true, workshopUpdates: true, joinRequests: false },
      prerequest: [
        'const original = pm.collectionVariables.get("originalNotificationPrefs");',
        'if (original) pm.request.body.update(original);',
      ],
      expect: 200,
    },

    // ---- organisation profile ----------------------------------------------------------
    {
      name: 'Organisation settings — read (OrgInfo)',
      method: 'GET',
      path: '/settings/organization',
      expect: 200,
      tests: ['pm.expect(json.name).to.be.a("string")', 'pm.expect(json.detachmentCount).to.be.a("number")'],
    },
    {
      name: 'Organisation settings — edit (org.edit)',
      method: 'PATCH',
      path: '/settings/organization',
      idempotent: true,
      body: { legalName: 'جمعية فرق الهلال الطبية', address: 'دمشق — المزة، شارع الجلاء', emailPublic: 'info@hilal-medical.org' },
      expect: 200,
      tests: ['pm.expect(json.emailPublic).to.eql("info@hilal-medical.org")'],
    },
    {
      name: 'Organisation settings — the display name is platform-owned → 422',
      method: 'PATCH',
      path: '/settings/organization',
      body: { name: 'اسم آخر' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("name")'],
    },
    {
      name: 'Organisation settings — Simple Admin (no org.edit) → 403',
      method: 'PATCH',
      path: '/settings/organization',
      auth: 'simple',
      body: { address: 'حمص' },
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Organisation logo — upload',
      method: 'POST',
      path: '/settings/organization/logo',
      formData: [{ key: 'image', type: 'file', src: 'fixtures/sample.jpg' }],
      expect: 200,
      tests: ['pm.expect(json.logoUrl).to.match(/\\/images\\/tenants\\//)'],
    },

    // ---- organisation snapshot + features -------------------------------------------------------
    {
      name: 'Organisation snapshot — Main Admin (usage included)',
      method: 'GET',
      path: '/tenant/organization',
      expect: 200,
      tests: [
        'pm.expect(json.organization.tenantId).to.eql("saas_hilal")',
        'pm.expect(json.limits.usageIncluded).to.eql(true)',
        'pm.expect(json.limits.items[0]).to.have.property("usage")',
        'pm.expect(JSON.stringify(json)).to.not.include("MTM-")',
      ],
    },
    {
      name: 'Organisation snapshot — Simple Admin (no usage)',
      method: 'GET',
      path: '/tenant/organization',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.limits.usageIncluded).to.eql(false)', 'json.limits.items.forEach(function (i) { pm.expect(i).to.not.have.property("usage"); })'],
    },
    {
      name: 'Module flags',
      method: 'GET',
      path: '/tenant/features',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.features.map(function (f) { return f.key; })).to.eql(["inventory","statistics_reports","workshops","announcements"])'],
    },

    // ---- Simple Admin management -------------------------------------------------------------
    readSnapshot('Simple Admins — snapshot'),
    {
      name: 'Simple Admins — Simple Admin (no admin.manage) → 403',
      method: 'GET',
      path: '/tenant/simple-admins',
      auth: 'simple',
      expect: 403,
    },
    {
      name: 'Invite a Simple Admin (random address)',
      method: 'POST',
      path: '/tenant/simple-admin-invitations',
      headers: { 'Idempotency-Key': '{{inviteKey}}' },
      prerequest: [
        'pm.collectionVariables.set("inviteKey", "invite-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));',
        'pm.collectionVariables.set("inviteEmail", "invitee." + Date.now() + "@leader.test");',
      ],
      body: {
        invitedEmail: '{{inviteEmail}}',
        suggestedName: 'مدعو تجريبي',
        capabilityKeys: ['detachment.view', 'member.view', 'shift.manage'],
        detachmentIds: ['d_dam_central'],
        expectedRevision: '{{adminRevision}}',
      },
      expect: 201,
      tests: ['pm.expect(json.status).to.eql("pending")', 'pm.expect(json.capabilities.scoped).to.have.property("d_dam_central")'],
      save: { invitationId: 'json.id' },
    },
    {
      name: 'Invite — same Idempotency-Key replays the original',
      method: 'POST',
      path: '/tenant/simple-admin-invitations',
      headers: { 'Idempotency-Key': '{{inviteKey}}' },
      body: {
        invitedEmail: '{{inviteEmail}}',
        suggestedName: 'مدعو تجريبي',
        capabilityKeys: ['detachment.view', 'member.view', 'shift.manage'],
        detachmentIds: ['d_dam_central'],
        expectedRevision: '{{adminRevision}}',
      },
      expect: 201,
      tests: [
        'pm.expect(json.id).to.eql(pm.collectionVariables.get("invitationId"))',
        'pm.expect(pm.response.headers.get("Idempotent-Replayed")).to.eql("true")',
      ],
    },
    {
      name: 'Invite — stale expectedRevision → 409 stale_admin_management',
      method: 'POST',
      path: '/tenant/simple-admin-invitations',
      idempotent: true,
      body: { invitedEmail: 'someone.else@leader.test', suggestedName: 'آخر', capabilityKeys: ['member.view'], expectedRevision: '{{adminRevision}}' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("stale_admin_management")'],
    },
    readSnapshot('Simple Admins — snapshot (after invite)'),
    {
      name: 'Cancel the invitation',
      method: 'POST',
      path: '/tenant/simple-admin-invitations/{{invitationId}}/cancel',
      idempotent: true,
      body: { expectedRevision: '{{adminRevision}}' },
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("cancelled")'],
    },
    {
      name: 'Resend a cancelled invitation → 409 conflict',
      method: 'POST',
      path: '/tenant/simple-admin-invitations/{{invitationId}}/resend',
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    readSnapshot('Simple Admins — snapshot (after cancel)'),
    {
      name: 'Simple Admin capabilities — keep the sub-admin preset in two detachments',
      method: 'PATCH',
      path: `/tenant/simple-admins/${SIMPLE_ADMIN_ID}/capabilities`,
      prerequest: [
        'const assignable = JSON.parse(pm.collectionVariables.get("assignableKeys") || "[]");',
        'const keys = assignable.filter(function (k) { return k !== "announcement.publish"; });',
        `pm.request.body.update(JSON.stringify({ capabilityKeys: keys, detachmentIds: ${JSON.stringify(SIMPLE_ADMIN_DETACHMENTS)}, expectedRevision: Number(pm.collectionVariables.get("adminRevision")) }));`,
      ],
      body: { capabilityKeys: ['member.view'], detachmentIds: SIMPLE_ADMIN_DETACHMENTS, expectedRevision: 1 },
      expect: 200,
      tests: ['pm.expect(json.id).to.eql("u_demo_simple")', 'pm.expect(json.capabilities.scoped).to.have.property("d_dam_central")'],
    },
    {
      name: 'Suspend your own account → 409 conflict',
      method: 'POST',
      path: '/tenant/simple-admins/u_demo_main/suspend',
      body: {},
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    {
      name: 'Tenant audit',
      method: 'GET',
      path: '/tenant/audit',
      query: { limit: 20 },
      expect: 200,
      tests: ['pm.expect(json.items).to.be.an("array")', 'pm.expect(json.items[0].category).to.eql("admin_management")'],
    },
  ],
};
