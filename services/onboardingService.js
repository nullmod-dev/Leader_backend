/**
 * Identity → session continuation, shared by sign-in, Google, email
 * verification and onboarding.
 *
 * The sign-in OUTCOME union (Flutter SignInOutcome):
 *
 *   { outcome: 'ready', accessToken, refreshToken }
 *   { outcome: 'verification_required', challenge: Challenge }
 *   { outcome: 'onboarding', onboardingToken, onboardingRefreshToken, snapshot: Snapshot }
 *
 * The onboarding SNAPSHOT (Flutter OnboardingSnapshot) never carries a tenant
 * id, a Team Code, counts or capabilities. `tenant` is present EXACTLY when
 * `linkStatus === 'linked'`.
 */
const { Authorization, SaasTenant, DemoSession } = require('../models');
const AppError = require('../utils/appError');
const tokenService = require('./tokenService');
const authorizationService = require('./authorizationService');
const otpService = require('./otpService');
const { serializeAuthUser, serializeSessionAccess } = require('./sessionView');

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * Password policy: a string of 8–128 characters, taken exactly as typed
 * (never trimmed). Anything else → 422 password_rejected.
 */
const assertPasswordPolicy = (password, field = 'password') => {
  const length = typeof password === 'string' ? Array.from(password).length : 0;
  if (typeof password !== 'string' || length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw new AppError('password_rejected', 422, `The password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`, {
      fields: { [field]: `Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters.` },
    });
  }
  return password;
};

/** Resolve the linked authorization + tenant, or null when the link no longer stands. */
const linkedTarget = async (account) => {
  if (account.linkStatus !== 'linked' || !account.linkedAuthorizationId) return null;
  const az = await Authorization.findById(account.linkedAuthorizationId);
  if (!az) return null;
  const tenant = await SaasTenant.findById(az.tenantId);
  if (!tenant) return null;
  return { az, tenant };
};

/** GET /auth/onboarding body. */
const snapshotOf = async (account) => {
  const target = await linkedTarget(account);
  const out = {
    accountId: String(account._id),
    email: account.email,
    methods: [...(account.methods || [])],
    accountStatus: account.status,
    linkStatus: account.linkStatus === 'linked' && !target ? 'withdrawn' : account.linkStatus,
    setupStatus: account.setupCompleted ? 'completed' : 'required',
  };
  if (target) {
    const { az, tenant } = target;
    out.tenant = { displayName: tenant.displayName, role: az.role, tenantStatus: tenant.lifecycle.status };
    const suggestion = az.suggestedName || account.name;
    if (suggestion) out.displayNameSuggestion = suggestion;
    if (az.expiresAt) out.authorizationExpiresAt = az.expiresAt.toISOString();
  } else if (account.name) {
    out.displayNameSuggestion = account.name;
  }
  return out;
};

/** `verification_required`: end the account's other challenges and mail a new code. */
const verificationRequired = async (account) => {
  await otpService.endActiveChallenges(account._id);
  const ch = await otpService.issueChallenge({ email: account.email, accountId: account._id });
  return { outcome: 'verification_required', challenge: otpService.serializeChallenge(ch) };
};

/**
 * A verified identity proved itself: auto-link a Simple Admin invitation,
 * then issue a FULL session (finished administrators — including suspended
 * or revoked ones, which the client routes on SessionAccess.accountStatus)
 * or an ONBOARDING session with the snapshot.
 */
const continueAfterAuthentication = async (account, req) => {
  await authorizationService.refreshLinkState(account);
  account.lastLoginAt = new Date();
  await account.save();

  if (account.setupCompleted || account.role === 'super_admin') {
    const { accessToken, refreshToken } = await tokenService.createSession(account, 'full', req);
    return { outcome: 'ready', accessToken, refreshToken };
  }
  const { accessToken, refreshToken } = await tokenService.createSession(account, 'onboarding', req);
  return {
    outcome: 'onboarding',
    onboardingToken: accessToken,
    onboardingRefreshToken: refreshToken,
    snapshot: await snapshotOf(account),
  };
};

/** GET /auth/me body: { user: AuthUser, access: SessionAccess }. */
const meView = async (account, session) => {
  let tenant = null;
  if (account.isTenantAdmin() && account.saasTenantId) {
    tenant = await SaasTenant.findById(account.saasTenantId);
    // A purged tenant still has to read as `deleted`, not as `active`.
    if (!tenant) tenant = { displayName: '', lifecycle: { status: 'deleted' } };
  }
  let demo = null;
  if (account.role === 'customer_demo' && account.demoSessionId) {
    demo = await DemoSession.findById(account.demoSessionId);
  }
  return { user: serializeAuthUser(account, tenant), access: serializeSessionAccess(account, tenant, session, demo) };
};

module.exports = {
  PASSWORD_MIN,
  PASSWORD_MAX,
  assertPasswordPolicy,
  snapshotOf,
  verificationRequired,
  continueAfterAuthentication,
  meView,
};
