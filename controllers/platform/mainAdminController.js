/**
 * /platform/tenants/:tenantId/main-admin/** — the Main Admin seat (Point 14;
 * screen: /platform/tenants/:tenantId/main-admin). The seat rules live in
 * services/authorizationService (seatSnapshot / seatCommands / assertRevision);
 * this controller only loads, serializes the transaction and answers
 * `{ snapshot, effect }`.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { withTransaction } = require('../../services/txn');
const settingsService = require('../../services/settingsService');
const { seatSnapshot, seatCommands, assertRevision } = require('../../services/authorizationService');
const lifecycleService = require('../../services/tenantLifecycleService');

const loadTenant = (tenantId, session) => lifecycleService.loadTenant(tenantId, { session });

/**
 * Recent authentication for commands that open or transfer tenant authority
 * (reactivate, replace). Mounted BEFORE `idempotent` so a refusal is never
 * stored against the key: the operator re-authenticates and retries the SAME draft.
 */
exports.requireRecentAuth = catchAsync(async (req, res, next) => {
  const { recentAuthMinutes } = await settingsService.get();
  const at = req.auth.session.authenticatedAt ? new Date(req.auth.session.authenticatedAt).getTime() : 0;
  if (Date.now() - at > recentAuthMinutes * 60000) {
    throw new AppError('recent_authentication_required', 403, 'Sign in again to perform this action.', { recentAuthMinutes });
  }
  next();
});

/** GET /platform/tenants/:tenantId/main-admin */
exports.get = catchAsync(async (req, res) => {
  const tenant = await loadTenant(req.params.tenantId);
  res.json(await seatSnapshot(tenant));
});

const command = (name, bodyOf = (req) => req.body) =>
  catchAsync(async (req, res) => {
    const actor = req.auth.account;
    const { effect } = await withTransaction(async (session) => {
      const tenant = await loadTenant(req.params.tenantId, session);
      assertRevision(tenant, req.body.expectedRevision);
      return seatCommands[name](tenant, bodyOf(req), actor, { session });
    });
    const tenant = await loadTenant(req.params.tenantId);
    res.json({ snapshot: await seatSnapshot(tenant), effect });
  });

exports.resendSetup = command('resendSetup');
exports.suspend = command('suspend');
exports.reactivate = command('reactivate');
exports.replace = command('replace');
exports.cancelReplacement = command('cancelReplacement', (req) => ({ ...req.body, replacementId: req.params.replacementId }));
