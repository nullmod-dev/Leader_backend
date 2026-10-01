/**
 * The two objects the Flutter startup classifier reads:
 *
 *   AuthUser       — lib/features/auth/domain/auth_models.dart
 *   SessionAccess  — lib/features/auth/domain/session_access.dart
 *
 * `GET /auth/me` answers { user: AuthUser, access: SessionAccess } — two
 * sibling objects, never merged, because access facts change without the
 * account changing.
 *
 * AuthUser invariant (the client REFUSES a violating payload):
 *   super_admin / customer_demo → saasTenantId: null (present, not omitted)
 *   main_admin / admin          → saasTenantId: a real id
 */
const config = require('../config');
const { normalizeGrant, emptyGrant } = require('../config/capabilities');
const { initialsOf } = require('../utils/normalize');

const PLATFORM_ORG_NAME = 'Leader';
const DEMO_ORG_NAME = 'تجربة ليدر';

const fileUrl = (path) => (path ? `${config.publicBaseUrl}${path}` : undefined);

const capabilitiesJson = (account) => {
  // super_admin holds NO Cap key; Cap.all never stands in for platform authority.
  if (account.role === 'super_admin' || account.role === 'customer_demo' || !account.role) return emptyGrant();
  return normalizeGrant(account.capabilities);
};

const serializeAuthUser = (account, tenant) => {
  const role = account.role;
  const tenantRole = role === 'main_admin' || role === 'admin';
  let orgName = PLATFORM_ORG_NAME;
  if (tenantRole) orgName = tenant ? tenant.displayName : '';
  if (role === 'customer_demo') orgName = DEMO_ORG_NAME;
  const out = {
    id: String(account._id),
    name: account.name || '',
    email: account.email || '',
    role,
    saasTenantId: tenantRole ? account.saasTenantId : null,
    capabilities: capabilitiesJson(account),
    orgName,
    avatarInitials: initialsOf(account.name || account.email || '?') || '?',
  };
  const avatarUrl = fileUrl(account.avatarPath);
  if (avatarUrl) out.avatarUrl = avatarUrl;
  return out;
};

/**
 * @param account      Account doc
 * @param tenant       SaasTenant doc (tenant roles) or null
 * @param session      Session doc
 * @param demoSession  DemoSession doc (customer_demo) or null
 */
const serializeSessionAccess = (account, tenant, session, demoSession) => {
  const out = {
    accountStatus: account.status,
    tenantStatus: tenant ? tenant.lifecycle.status : 'active',
    demoMode: 'none',
    mfaRequired: !!(account.mfa && account.mfa.enabled && session && !session.mfaVerified),
  };
  if (account.role === 'customer_demo') {
    const status = demoSession ? demoSession.statusAt() : 'expired';
    out.demoMode = status === 'active' ? 'active' : 'expired';
    if (demoSession) out.sessionExpiresAt = demoSession.expiresAt.toISOString();
  }
  return out;
};

module.exports = { serializeAuthUser, serializeSessionAccess, fileUrl, capabilitiesJson };
