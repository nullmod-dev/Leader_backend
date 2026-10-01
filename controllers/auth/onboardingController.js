/**
 * Onboarding (restricted session): read the snapshot, link a Main Admin seat
 * by Team Code, complete account setup.
 *
 * Link refusals, in this order (never collapsed):
 *   account suspended/revoked      → 403 account_unavailable
 *   too many failed links (10/h)   → 429 rate_limited
 *   malformed Team Code            → 422 team_code_malformed (spends nothing)
 *   already linked, other tenant   → 409 account_already_linked (the code is
 *                                    not evaluated, the tenant never named)
 *   unknown code OR no pending seat
 *   authorization for this address → 403 team_link_refused (ONE answer)
 *   authorization expired          → 409 invitation_expired
 *   tenant not active              → 409 tenant_unavailable (+tenantStatus)
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account, Authorization, SaasTenant, Session } = require('../../models');
const authorizationService = require('../../services/authorizationService');
const securityService = require('../../services/securityService');
const tokenService = require('../../services/tokenService');
const onboarding = require('../../services/onboardingService');
const { withTransaction } = require('../../services/txn');
const { bearer } = require('../../middlewares/auth');
const { normalizeTeamCode } = require('../../utils/normalize');

const SEAT_KINDS = ['initial_seat', 'replacement_designate'];
const LINK_BUDGET = { max: 10, windowMinutes: 60 };

// GET /auth/onboarding → Snapshot
exports.get = catchAsync(async (req, res) => {
  const { account } = req.auth;
  await authorizationService.refreshLinkState(account);
  res.status(200).json(await onboarding.snapshotOf(account));
});

// POST /auth/onboarding/link {teamCode} → Snapshot
exports.link = catchAsync(async (req, res) => {
  const { account } = req.auth;
  const accountId = String(account._id);

  if (account.status === 'suspended' || account.status === 'revoked') {
    throw new AppError('account_unavailable', 403, 'This account is not available.', { accountStatus: account.status });
  }
  await securityService.assertBudget('team_link_failed', { accountId }, LINK_BUDGET);

  const teamCode = normalizeTeamCode(req.body.teamCode);
  if (!teamCode) {
    throw new AppError('team_code_malformed', 422, 'A Team Code looks like MTM-XXXX-XXXX.', {
      fields: { teamCode: 'Enter the 8-character Team Code.' },
    });
  }

  await authorizationService.refreshLinkState(account);

  if (account.linkStatus === 'linked' && account.linkedAuthorizationId) {
    const current = await Authorization.findById(account.linkedAuthorizationId);
    const tenant = await SaasTenant.findOne({ teamCode });
    if (current && tenant && current.tenantId === String(tenant._id)) {
      res.status(200).json(await onboarding.snapshotOf(account));
      return;
    }
    throw new AppError('account_already_linked', 409, 'This account is already linked to a team.');
  }

  const tenant = await SaasTenant.findOne({ teamCode });
  const az = tenant
    ? await Authorization.findOne({
        tenantId: String(tenant._id),
        kind: { $in: SEAT_KINDS },
        status: 'pending',
        email: account.email,
      }).sort({ createdAt: -1 })
    : null;
  if (!tenant || !az) {
    await securityService.signal('team_link_failed', { accountId, ip: req.ip });
    throw new AppError('team_link_refused', 403, 'This Team Code cannot be used with this account.');
  }
  if (az.expiresAt && az.expiresAt <= new Date()) {
    throw new AppError('invitation_expired', 409, 'The invitation has expired. Ask for a new one.');
  }
  if (tenant.lifecycle.status !== 'active') {
    throw new AppError('tenant_unavailable', 409, 'The team is not active.', { tenantStatus: tenant.lifecycle.status });
  }

  await withTransaction(async (session) => {
    const fresh = await Account.findById(accountId).session(session || null);
    fresh.linkStatus = 'linked';
    fresh.linkedAuthorizationId = String(az._id);
    await fresh.save({ session });
    await Authorization.updateOne({ _id: az._id }, { $set: { linkedAccountId: accountId } }, { session });
  });
  const linked = await Account.findById(accountId);
  res.status(200).json(await onboarding.snapshotOf(linked));
});

/**
 * Mounted BEFORE idempotent() on /onboarding/complete: verify the bearer's
 * signature only (the session may already be revoked by the first call) so
 * the Idempotency-Key is scoped to the account and the `ready` outcome can
 * be replayed after the onboarding session was consumed.
 */
exports.stashSubject = (req, res, next) => {
  const token = bearer(req);
  if (token) {
    try {
      req.onboardingSubject = tokenService.signedSubject(token);
    } catch (e) {
      /* the real check is protectOnboarding */
    }
  }
  next();
};

exports.completeActor = (req) => (req.onboardingSubject ? `acc:${req.onboardingSubject}` : null);

// POST /auth/onboarding/complete {displayName} → { outcome: 'ready', ... }
exports.complete = catchAsync(async (req, res) => {
  const accountId = String(req.auth.account._id);
  const currentSessionId = String(req.auth.session._id);

  const account = await withTransaction(async (session) => {
    const fresh = await Account.findById(accountId).session(session || null);
    await authorizationService.refreshLinkState(fresh, { session });
    await authorizationService.completeSetup(fresh, req.body.displayName, { session });
    await tokenService.revokeSession(currentSessionId, 'setup_completed', { session });
    // Any other restricted session of this identity is obsolete too.
    await Session.updateMany(
      { accountId, scope: 'onboarding', revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokeReason: 'setup_completed' } },
      { session },
    );
    return fresh;
  });

  const { accessToken, refreshToken } = await tokenService.createSession(account, 'full', req);
  res.status(200).json({ outcome: 'ready', accessToken, refreshToken });
});
