/**
 * Identity → session continuation, shared by sign-in, Google, email
 * verification and onboarding.
 *
 * The sign-in OUTCOME union (Flutter SignInOutcome):
 *
 *   { outcome: 'ready', sessionId, accessToken, refreshToken }
 *   { outcome: 'verification_required', challenge: Challenge }
 *   { outcome: 'onboarding', sessionId, onboardingToken, onboardingRefreshToken, snapshot: Snapshot }
 *
 * The onboarding SNAPSHOT (Flutter OnboardingSnapshot) never carries a tenant
 * id, a Team Code, counts or capabilities. `tenant` is present EXACTLY when
 * `linkStatus === 'linked'`; an unlinked one may carry `pendingInvitation:
 * { role, tenantDisplayName }` for a Main Admin seat waiting for its address.
 */
const { Authorization, SaasTenant, DemoSession } = require('../models');
const AppError = require('../utils/appError');
const tokenService = require('./tokenService');
const authorizationService = require('./authorizationService');
const otpService = require('./otpService');
const deviceService = require('./deviceService');
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

/**
 * A Main Admin seat waiting for this address, as an unlinked account may be
 * told it before typing the Team Code: the role and the team's name — never
 * the tenant id or the code itself. Only a usable seat of an active tenant;
 * anything else would promise a link the Team Code step then refuses.
 */
const pendingSeatInvitation = async (account) => {
  const now = new Date();
  const seats = await Authorization.find({
    email: account.email,
    kind: { $in: ['initial_seat', 'replacement_designate'] },
    status: 'pending',
  }).sort({ createdAt: -1 });
  for (const az of seats) {
    if (!az.isUsable(now)) continue;
    const tenant = await SaasTenant.findById(az.tenantId);
    if (!tenant || tenant.lifecycle.status !== 'active') continue;
    return { role: az.role, tenantDisplayName: tenant.displayName };
  }
  return null;
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
  } else {
    if (account.name) out.displayNameSuggestion = account.name;
    const invitation = await pendingSeatInvitation(account);
    if (invitation) out.pendingInvitation = invitation;
  }
  return out;
};

/**
 * `verification_required`: end the account's other challenges and mail a new
 * code. `purpose: 'sign_in'` is a returning account's Google sign-in (see
 * identityController.google); `googleSub` is linked when its code is right.
 */
const verificationRequired = async (account, { purpose = 'email', googleSub } = {}) => {
  await otpService.endActiveChallenges(account._id);
  const ch = await otpService.issueChallenge({ email: account.email, accountId: account._id, purpose, googleSub });
  return { outcome: 'verification_required', challenge: otpService.serializeChallenge(ch) };
};

/**
 * A verified identity proved itself: admit the device (services/deviceService
 * — a device the account does not trust answers `verification_required`
 * with purpose `new_device` until its email code is verified), auto-link a
 * Simple Admin invitation, then issue a FULL session (finished administrators
 * — including suspended or revoked ones, which the client routes on
 * SessionAccess.accountStatus) or an ONBOARDING session with the snapshot.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.codeVerified]  an email code was verified just now
 */
const continueAfterAuthentication = async (account, req, { codeVerified = false } = {}) => {
  const admission = await deviceService.admit(account, req, { codeVerified });
  if (admission.needsCode) return verificationRequired(account, { purpose: 'new_device' });
  const deviceRef = admission.device ? String(admission.device._id) : undefined;

  await authorizationService.refreshLinkState(account);
  account.lastLoginAt = new Date();
  await account.save();

  if (account.setupCompleted || account.role === 'super_admin') {
    return { outcome: 'ready', ...tokenService.pair(await tokenService.createSession(account, 'full', req, { deviceRef })) };
  }
  const { session, accessToken, refreshToken } = await tokenService.createSession(account, 'onboarding', req, { deviceRef });
  return {
    outcome: 'onboarding',
    sessionId: String(session._id),
    onboardingToken: accessToken,
    onboardingRefreshToken: refreshToken,
    snapshot: await snapshotOf(account),
  };
};

/** GET /auth/me body: { sessionId, user: AuthUser, access: SessionAccess }. */
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
  return {
    ...(session ? { sessionId: String(session._id) } : {}),
    user: serializeAuthUser(account, tenant),
    access: { ...serializeSessionAccess(account, tenant, session, demo), ...(await deviceService.accessFacts(account, session)) },
  };
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
