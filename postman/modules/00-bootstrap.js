/**
 * Folder 0 — signs in the three seeded accounts and stores their tokens in
 * collection variables for every later folder. Never signs them out.
 */
const signIn = (who, emailVar, tokenVar, extraSave = {}) => ({
  name: `Sign in — ${who}`,
  method: 'POST',
  path: '/auth/sign-in',
  auth: 'none',
  body: { email: `{{${emailVar}}}`, password: '{{seedPassword}}' },
  expect: 200,
  tests: ['pm.expect(json.outcome).to.eql("ready")', 'pm.expect(json.accessToken).to.be.a("string")', 'pm.expect(json.refreshToken).to.be.a("string")'],
  save: { [tokenVar]: 'json.accessToken', ...extraSave },
  description: `Seeded ${who} (SEED_PASSWORD). Stores \`{{${tokenVar}}}\`.`,
});

const me = (who, auth, role, tenantCheck) => ({
  name: `Me — ${who}`,
  method: 'GET',
  path: '/auth/me',
  auth,
  expect: 200,
  tests: [
    `pm.expect(json.user.role).to.eql("${role}")`,
    tenantCheck,
    'pm.expect(json.access.accountStatus).to.eql("active")',
    'pm.expect(json.access.mfaRequired).to.eql(false)',
  ],
});

module.exports = {
  name: 'Bootstrap · sign in seeded accounts',
  order: 0,
  description:
    'Signs in the seeded Super Admin, Main Admin (saas_hilal) and Simple Admin with `{{seedPassword}}` and stores ' +
    '`platformToken`, `mainAdminToken` (+ `mainAdminRefreshToken`) and `simpleAdminToken`. Run `npm run seed:reset` first.',
  auth: 'none',
  items: [
    signIn('Super Admin', 'platformEmail', 'platformToken'),
    signIn('Main Admin', 'mainAdminEmail', 'mainAdminToken', { mainAdminRefreshToken: 'json.refreshToken' }),
    signIn('Simple Admin', 'simpleAdminEmail', 'simpleAdminToken'),
    me('Super Admin', 'platform', 'super_admin', 'pm.expect(json.user.saasTenantId).to.eql(null)'),
    me('Main Admin', 'main', 'main_admin', 'pm.expect(json.user.saasTenantId).to.eql("saas_hilal")'),
    me('Simple Admin', 'simple', 'admin', 'pm.expect(json.user.saasTenantId).to.eql("saas_hilal")'),
  ],
};
