/**
 * /platform/tenants/:tenantId/subscription/** and /limits/** — the Point 7
 * commercial snapshot, plan assignment and per-tenant limit overrides
 * (screens: tenant detail → subscription, → limits).
 *
 *   trial ──activate──▶ active ──grace──▶ grace ──activate──▶ active
 *   trial ──trial/end─▶ grace             inactive ──activate──▶ active
 *   trial ──trial/extend─▶ trial          any ──plan──▶ same status, new planId
 *
 * Check order of every mutation: tenant (404 not_found) → plan validity
 * (404 plan_not_found / 409 plan_unavailable) → version (409 stale_subscription)
 * → transition (409 invalid_subscription_transition / 422 invalid_trial_extension).
 * Lifecycle, features and the Team Code are never touched here.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Plan } = require('../../models');
const { PLAN_LIMIT_KEYS, SUBSCRIPTION_STATUS } = require('../../config/constants');
const { withTransaction } = require('../../services/txn');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const usageService = require('../../services/usageService');
const lifecycleService = require('../../services/tenantLifecycleService');
const { serializeSubscription } = require('../../services/tenantView');

const DAY_MS = lifecycleService.DAY_MS;

const loadTenant = (tenantId, session) =>
  lifecycleService.loadTenant(tenantId, { session, missingCode: 'not_found', tombstoneCode: null });

const planNotFound = (status = 404) => new AppError('plan_not_found', status, 'plan not found');

const plainLimits = (plan) => {
  const src = plan.defaultLimits && plan.defaultLimits.toObject ? plan.defaultLimits.toObject() : plan.defaultLimits || {};
  return Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, src[k]]));
};

/** { subscription, currentPlan } — planId set but unresolvable → 409 plan_not_found. */
const snapshotOf = async (tenant) => {
  const planId = tenant.subscription.planId;
  let currentPlan = null;
  if (planId) {
    const plan = await Plan.findById(planId);
    if (!plan) throw planNotFound(409);
    currentPlan = plan.toJSON();
  }
  return { subscription: serializeSubscription(tenant), currentPlan };
};

/** The limits projection (GET /limits and the PATCH /limits/:key answer). */
const limitsOf = async (tenant) => {
  const { plan, usage, rows } = await usageService.limitRows(tenant);
  if (!plan) throw planNotFound(409);
  return {
    tenantId: String(tenant._id),
    tenantName: tenant.displayName,
    plan: { id: String(plan._id), name: plan.name, defaultLimits: plainLimits(plan) },
    subscription: { version: tenant.subscription.version, limitOverrides: usageService.overridesOf(tenant) },
    usage,
    effective: usageService.effectiveLimits(tenant, plan),
    rows,
  };
};

const assertVersion = (tenant, expected) => {
  if (tenant.subscription.version !== expected) {
    throw new AppError('stale_subscription', 409, 'The subscription changed since you read it.', {
      currentVersion: tenant.subscription.version,
    });
  }
};

const invalidTransition = (message) => new AppError('invalid_subscription_transition', 409, message);

/** A plan chosen by the command: must exist; a NEW selection must be selectable. */
const selectedPlan = async (tenant, planId, session) => {
  const plan = await Plan.findById(planId).session(session || null);
  if (!plan) throw planNotFound(404);
  if (plan.selectable === false && tenant.subscription.planId !== String(plan._id)) {
    throw new AppError('plan_unavailable', 409, 'This plan is not available for new selections.');
  }
  return plan;
};

const COMMANDS = {
  activate: {
    choosesPlan: true,
    from: ['trial', 'grace', 'inactive'],
    event: 'subscription_activated',
    audit: 'subscription_activated',
    target: 'subscription',
    apply(tenant, { plan, now }) {
      const s = tenant.subscription;
      s.status = 'active';
      s.planId = String(plan._id);
      s.renewsAt = new Date(now.getTime() + 365 * DAY_MS);
      s.trialEndsAt = null;
      s.graceEndsAt = null;
    },
  },
  extendTrial: {
    from: ['trial'],
    event: 'trial_extended',
    audit: 'trial_extended',
    target: 'subscription',
    guard(tenant, { body, now }) {
      const next = new Date(body.newEndsAt);
      const current = tenant.subscription.trialEndsAt ? new Date(tenant.subscription.trialEndsAt) : null;
      if (next.getTime() <= now.getTime() || (current && next.getTime() <= current.getTime())) {
        throw new AppError('invalid_trial_extension', 422, 'The new trial end must be later than now and than the current end.');
      }
    },
    apply(tenant, { body }) {
      tenant.subscription.trialEndsAt = new Date(body.newEndsAt);
    },
  },
  endTrial: {
    from: ['trial'],
    event: 'trial_ended',
    audit: 'trial_ended',
    target: 'subscription',
    apply(tenant, { now, settings }) {
      const s = tenant.subscription;
      s.status = 'grace';
      s.graceEndsAt = new Date(now.getTime() + settings.graceDays * DAY_MS);
      s.trialEndsAt = null;
    },
  },
  moveToGrace: {
    from: ['active'],
    event: 'moved_to_grace',
    audit: 'subscription_moved_to_grace',
    target: 'subscription',
    apply(tenant, { now, settings }) {
      const s = tenant.subscription;
      s.status = 'grace';
      s.graceEndsAt = new Date(now.getTime() + settings.graceDays * DAY_MS);
      s.renewsAt = null;
    },
  },
  changePlan: {
    choosesPlan: true,
    from: SUBSCRIPTION_STATUS,
    event: 'plan_changed',
    audit: 'plan_changed',
    target: 'plan_assignment',
    guard(tenant, { plan }) {
      if (tenant.subscription.planId === String(plan._id)) throw invalidTransition('The team already has this plan.');
    },
    apply(tenant, { plan }) {
      tenant.subscription.planId = String(plan._id);
    },
  },
};

const changesOf = (name, before, tenant) => {
  const after = { status: tenant.subscription.status, planId: tenant.subscription.planId || null };
  if (name === 'changePlan') return [{ field: 'plan_assignment', before: before.planId, after: after.planId }];
  const out = [{ field: 'subscription_status', before: before.status, after: after.status }];
  if (name === 'activate') out.push({ field: 'plan_assignment', before: before.planId, after: after.planId });
  return out;
};

const command = (name) =>
  catchAsync(async (req, res) => {
    const spec = COMMANDS[name];
    const actor = req.auth.account;
    const settings = await settingsService.get();

    const tenant = await withTransaction(async (session) => {
      const now = new Date();
      const t = await loadTenant(req.params.tenantId, session);
      const plan = spec.choosesPlan ? await selectedPlan(t, req.body.planId, session) : null;
      assertVersion(t, req.body.expectedVersion);
      if (!spec.from.includes(t.subscription.status)) {
        throw invalidTransition(`Cannot ${name} a subscription in ${t.subscription.status}.`);
      }
      const ctx = { body: req.body, plan, now, settings };
      if (spec.guard) spec.guard(t, ctx);

      const before = { status: t.subscription.status, planId: t.subscription.planId || null };
      spec.apply(t, ctx);
      t.subscription.version += 1;
      await t.save({ session });

      await lifecycleService.recordEvent(t._id, spec.event, null, { session, occurredAt: now });
      await auditService.record({
        action: spec.audit,
        actor,
        target: { type: spec.target, id: String(t._id), displayName: t.displayName },
        tenant: t,
        changes: changesOf(name, before, t),
        session,
      });
      return t;
    });

    res.json(await snapshotOf(tenant));
  });

/** GET /platform/tenants/:tenantId/subscription */
exports.get = catchAsync(async (req, res) => {
  const tenant = await loadTenant(req.params.tenantId);
  res.json(await snapshotOf(tenant));
});

/** GET /platform/tenants/:tenantId/limits */
exports.limits = catchAsync(async (req, res) => {
  const tenant = await loadTenant(req.params.tenantId);
  res.json(await limitsOf(tenant));
});

exports.activate = command('activate');
exports.extendTrial = command('extendTrial');
exports.endTrial = command('endTrial');
exports.moveToGrace = command('moveToGrace');
exports.changePlan = command('changePlan');

const limitInvalid = (message) => new AppError('limit_invalid', 422, message);

/** PATCH /platform/tenants/:tenantId/limits/:limitKey { overrideValue: int ≥ 0 | null, expectedVersion } */
exports.setLimitOverride = catchAsync(async (req, res) => {
  const actor = req.auth.account;
  const { limitKey } = req.params;
  const { overrideValue, expectedVersion } = req.body;

  const tenant = await withTransaction(async (session) => {
    const now = new Date();
    const t = await loadTenant(req.params.tenantId, session);
    if (!PLAN_LIMIT_KEYS.includes(limitKey)) throw limitInvalid(`Unknown limit key ${limitKey}.`);
    if (overrideValue !== null && !(Number.isInteger(overrideValue) && overrideValue >= 0)) {
      throw limitInvalid('overrideValue must be a non-negative integer or null.');
    }
    if (!t.subscription.planId) throw planNotFound(409);
    const plan = await Plan.findById(t.subscription.planId).session(session || null);
    if (!plan) throw planNotFound(409);
    assertVersion(t, expectedVersion);

    const overrides = t.subscription.limitOverrides;
    const before = overrides.has(limitKey) ? overrides.get(limitKey) : null;
    if (overrideValue === null) overrides.delete(limitKey);
    else overrides.set(limitKey, overrideValue);
    t.markModified('subscription.limitOverrides');
    t.subscription.version += 1;
    await t.save({ session });

    await lifecycleService.recordEvent(t._id, 'limit_override_changed', null, { session, occurredAt: now });
    await auditService.record({
      action: 'limit_override_changed',
      actor,
      target: { type: 'tenant_limit', id: limitKey },
      tenant: t,
      changes: [{ field: 'limit_override', before, after: overrideValue }],
      session,
    });
    return t;
  });

  res.json(await limitsOf(tenant));
});
