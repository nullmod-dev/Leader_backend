/**
 * Authentication and the authorization chain.
 *
 * TENANT request — evaluated in this exact order, each a DISTINCT refusal:
 *   1. session valid           → 401 authentication_expired
 *   2. session tier = full     → 403 onboarding_required
 *   3. MFA satisfied           → 403 mfa_required
 *   4. account lifecycle       → 403 account_unavailable
 *   5. surface = tenant role   → 403 tenant_context_unavailable
 *   6. tenant lifecycle active → 403 tenant_unavailable (+ tenantStatus)
 *   7. feature flag            → 403 feature_disabled   (requireFeature)
 *   8. capability              → 403 not_permitted      (requireCap*)
 *   9. plan limit              → 409 plan_limit_reached (usageService, in controllers)
 *
 * PLATFORM request: 1 → 2 → 3 → 4 → role super_admin (403 not_permitted).
 * The tenant is ALWAYS taken from the verified account, never from the request.
 */
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsyncErrors');
const tokenService = require('../services/tokenService');
const usageService = require('../services/usageService');
const tenantContext = require('../services/tenantContext');
const deviceService = require('../services/deviceService');
const restrictedSession = require('./restrictedSession');
const { Account, Session, SaasTenant, Device } = require('../models');
const caps = require('../config/capabilities');

const bearer = (req) => {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
};

const EXPIRED = () => new AppError('authentication_expired', 401, 'The session has ended. Sign in again.');

/**
 * The session's device. A session opened before device trust shipped has none
 * until its first request carrying X-Device-Id, which registers that phone
 * (services/deviceService.bindLegacySession). A blocked or removed device
 * ends the session.
 */
const resolveDevice = async (account, session, req) => {
  if (session.deviceRef) {
    const device = await Device.findById(session.deviceRef);
    if (!device || device.status === 'blocked') throw EXPIRED();
    return device;
  }
  if (account.role === 'customer_demo') return null;
  return deviceService.bindLegacySession(account, session, req);
};

/**
 * Resolve the bearer into req.auth = { account, session, scope, device, restriction }.
 * `restriction` (null, or { reason, until }) is the device-trust restriction
 * middlewares/restrictedSession.js enforces.
 * @param {object} opts
 * @param {'full'|'onboarding'|'any'} opts.scope   which session tier may call
 * @param {boolean} opts.optional  no bearer → continue unauthenticated
 */
const authenticate = ({ scope = 'full', optional = false } = {}) =>
  catchAsync(async (req, res, next) => {
    // Two routers can match one request (e.g. /detachments and
    // /detachments/:id/shifts); authenticate once per request.
    if (req.auth && (scope === 'any' || req.auth.scope === scope)) return next();
    const token = bearer(req);
    if (!token) {
      if (optional) return next();
      throw EXPIRED();
    }
    let payload;
    try {
      payload = tokenService.verifyAccess(token);
    } catch (e) {
      if (optional) return next();
      throw EXPIRED();
    }
    const session = await Session.findById(payload.sid);
    if (!session || !session.isLive() || session.accountId !== payload.sub) throw EXPIRED();
    const account = await Account.findById(payload.sub);
    if (!account) throw EXPIRED();

    if (scope === 'full' && session.scope !== 'full') {
      throw new AppError('onboarding_required', 403, 'Finish onboarding first.');
    }
    if (scope === 'onboarding' && session.scope !== 'onboarding') {
      throw new AppError('setup_already_completed', 409, 'This session is already a full session.');
    }
    const device = await resolveDevice(account, session, req);
    req.auth = { account, session, scope: session.scope, device, restriction: deviceService.restrictionOf(device) };
    restrictedSession.assertAllowed(req);
    // Cheap last-used bookkeeping (at most once a minute).
    if (Date.now() - new Date(session.lastUsedAt).getTime() > 60000) {
      const now = new Date();
      Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: now } }).catch(() => {});
      if (device) Device.updateOne({ _id: device._id }, { $set: { lastSeenAt: now } }).catch(() => {});
    }
    return next();
  });

const protect = authenticate({ scope: 'full' });
const protectOnboarding = authenticate({ scope: 'onboarding' });
const protectAny = authenticate({ scope: 'any' });
const optionalAuth = authenticate({ scope: 'any', optional: true });

/** MFA: a session of an MFA-enabled account must verify before anything else. */
const requireMfa = (req, res, next) => {
  const { account, session } = req.auth;
  if (account.mfa && account.mfa.enabled && !session.mfaVerified) {
    return next(new AppError('mfa_required', 403, 'Verify your second factor first.'));
  }
  return next();
};

const requireActiveAccount = (req, res, next) => {
  const { account } = req.auth;
  if (account.status !== 'active') {
    return next(new AppError('account_unavailable', 403, 'This account is not active.', { accountStatus: account.status }));
  }
  return next();
};

/** Tenant surface + tenant lifecycle. Sets req.tenant, req.tenantId, req.grant. */
const tenantSurface = catchAsync(async (req, res, next) => {
  if (req.tenant && req.tenantId && req.grant) return next(); // already resolved for this request
  const { account } = req.auth;
  if (!account.isTenantAdmin() || !account.saasTenantId) {
    throw new AppError('tenant_context_unavailable', 403, 'This session has no team context.');
  }
  const tenant = await SaasTenant.findById(account.saasTenantId);
  if (!tenant) throw new AppError('tenant_unavailable', 403, 'The team no longer exists.', { tenantStatus: 'deleted' });
  if (tenant.lifecycle.status !== 'active') {
    throw new AppError('tenant_unavailable', 403, 'The team is not active.', { tenantStatus: tenant.lifecycle.status });
  }
  req.tenant = tenant;
  req.tenantId = String(tenant._id);
  req.grant = caps.normalizeGrant(account.capabilities);
  req.tz = tenant.timezone || 'Asia/Damascus';
  usageService.touchActivity(tenant).catch(() => {});
  // Everything after this point runs inside the verified tenant's context:
  // the data-layer guard (models/plugins/tenantScope.js) refuses any query
  // that is not filtered to exactly this tenant.
  // `deviceId` lets models/plugins/base.js stamp who created each new record
  // (a restricted device may edit only its own).
  const { device } = req.auth;
  return tenantContext.run({ tenantId: req.tenantId, accountId: String(account._id), deviceId: device ? String(device._id) : undefined }, () =>
    next(),
  );
});

const platformSurface = (req, res, next) => {
  if (req.auth.account.role !== 'super_admin') return next(AppError.notPermitted('Platform access only.'));
  return next();
};

/** The full chains most routers mount once. */
const tenantGuard = [protect, requireMfa, requireActiveAccount, tenantSurface];
const platformGuard = [protect, requireMfa, requireActiveAccount, platformSurface];
/** Any full session (tenant, platform or demo) — account-own endpoints. */
const accountGuard = [protect, requireMfa];

// ---- feature + capability gates -------------------------------------------------

const requireFeature = (key) => (req, res, next) => {
  if (!req.tenant || !req.tenant.featureEnabled(key)) {
    return next(new AppError('feature_disabled', 403, `The ${key} module is not enabled for this team.`, { feature: key }));
  }
  return next();
};

/** Global capability. */
const requireCap = (key) => (req, res, next) => {
  if (!caps.can(req.grant, key)) return next(AppError.notPermitted(`Requires ${key}.`));
  return next();
};

/**
 * Detachment-scoped capability. `resolve(req)` returns the detachment id
 * (sync or async) — e.g. from params, body, or an entity loaded by
 * `loadTenantDoc`.
 */
const requireCapIn = (key, resolve) =>
  catchAsync(async (req, res, next) => {
    const detId = await resolve(req);
    if (!caps.canIn(req.grant, detId, key)) throw AppError.notPermitted(`Requires ${key} in this detachment.`);
    next();
  });

const requireAnyCapIn = (keys, resolve) =>
  catchAsync(async (req, res, next) => {
    const detId = await resolve(req);
    if (!caps.canAnyIn(req.grant, detId, keys)) throw AppError.notPermitted(`Requires one of ${keys.join(', ')}.`);
    next();
  });

/** Held globally or in any detachment. */
const requireCapAnywhere = (key) => (req, res, next) => {
  if (!caps.canAnywhere(req.grant, key)) return next(AppError.notPermitted(`Requires ${key}.`));
  return next();
};

/**
 * Load a tenant-scoped document by route param into `req.docs[name]`,
 * answering 404 not_found when it does not exist IN THIS TENANT. A write that
 * targets it from a restricted session must be the device's own record
 * (middlewares/restrictedSession.assertOwnRecord).
 */
const loadTenantDoc = (Model, param, name) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findOne({ _id: req.params[param], tenantId: req.tenantId }).select('+_createdByDevice');
    if (!doc) throw AppError.notFound(name);
    restrictedSession.assertOwnRecord(req, doc);
    req.docs = req.docs || {};
    req.docs[name] = doc;
    next();
  });

/** Detachment id of a loaded doc (for requireCapIn). */
const fromDoc = (name, field = 'detachmentId') => (req) => req.docs[name][field];
const fromParam = (param) => (req) => req.params[param];
const fromBody = (field) => (req) => req.body && req.body[field];
const fromQuery = (field) => (req) => req.query && req.query[field];

module.exports = {
  bearer,
  authenticate,
  protect,
  protectOnboarding,
  protectAny,
  optionalAuth,
  requireMfa,
  requireActiveAccount,
  tenantSurface,
  platformSurface,
  tenantGuard,
  platformGuard,
  accountGuard,
  requireFeature,
  requireCap,
  requireCapIn,
  requireAnyCapIn,
  requireCapAnywhere,
  loadTenantDoc,
  fromDoc,
  fromParam,
  fromBody,
  fromQuery,
};
