/**
 * Query validation for the Super Admin insight reads: overview, health,
 * security, audit, reports, analytics and jobs.
 *
 * Instants are RFC 3339; an instant sent WITHOUT an offset is read as UTC
 * (the control plane has no tenant timezone). Reports use `validateStrict`
 * because their contract rejects unknown parameters with `validation`
 * (API_CONTRACT.md → Platform Reports → Shared query rules); every other read
 * uses the shared `validate` middleware, which strips unknown keys.
 */
const Joi = require('joi');
const AppError = require('../utils/appError');
const { toFields } = require('../middlewares/validate');
const { parseInstant } = require('../utils/time');
const { SUBSCRIPTION_STATUS, PLAN_LIMIT_KEYS, FEATURE_KEYS } = require('../config/constants');

// ---- building blocks ------------------------------------------------------------

/** RFC 3339 instant → Date (offset-less = UTC). */
const instant = () =>
  Joi.any()
    .custom((value, helpers) => {
      const date = parseInstant(value, 'UTC');
      return date || helpers.error('any.invalid');
    })
    .messages({ 'any.invalid': '{{#label}} must be an RFC 3339 instant' });

/**
 * Comma list (`a,b`) or repeated parameter (`?k=a&k=b`) of closed values →
 * de-duplicated array. Empty or unknown members are a validation failure.
 */
const csvOf = (allowed) =>
  Joi.any()
    .custom((value, helpers) => {
      const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length) return helpers.error('any.invalid');
      if (parts.some((p) => !allowed.includes(p))) return helpers.error('any.invalid');
      return [...new Set(parts)];
    })
    .messages({ 'any.invalid': `{{#label}} must be a comma list of: ${allowed.join(', ')}` });

const limit = (def = 50) => Joi.number().integer().min(1).max(100).default(def);
const cursor = () => Joi.string().max(2048).allow('');
const id = () => Joi.string().trim().max(128);

const REPORTABLE_LIFECYCLE = ['active', 'suspended', 'deletion_pending'];
const USAGE_BANDS = ['within_limit', 'at_limit', 'over_limit', 'no_limit'];
const FEATURE_STATES = ['enabled', 'disabled'];
const ACTIVITY_CATEGORIES = [
  'tenant_management',
  'subscription',
  'entitlement',
  'lifecycle',
  'emergency_access',
  'account_management',
  'customer_demo',
];
const PERIODS = ['7d', '30d', '90d', '365d'];

/**
 * Like middlewares/validate but REJECTS unknown keys (reports contract).
 * Converted values replace req.query in place.
 */
const validateStrict = (schema) => (req, res, next) => {
  const { value, error } = schema.validate(req.query ?? {}, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: false,
    convert: true,
  });
  if (error) return next(AppError.validation(toFields(error.details)));
  Object.keys(req.query).forEach((k) => delete req.query[k]);
  Object.assign(req.query, value);
  return next();
};

// ---- audit ---------------------------------------------------------------------------

const auditList = Joi.object({
  from: instant(),
  before: instant(),
  actorKind: Joi.string().trim().max(64),
  actorId: id(),
  action: Joi.string().trim().max(64),
  category: Joi.string().trim().max(64),
  tenantId: id(),
  targetType: Joi.string().trim().max(64),
  search: Joi.string().trim().max(200).allow(''),
  cursor: cursor(),
  limit: limit(50),
});

// ---- reports (strict) ----------------------------------------------------------------

const reportCommon = {
  lifecycle: csvOf(REPORTABLE_LIFECYCLE),
  planId: id(),
  noPlan: Joi.boolean(),
  cursor: cursor(),
  limit: limit(50),
};

const subscriptionsReport = Joi.object({
  ...reportCommon,
  status: csvOf(SUBSCRIPTION_STATUS),
  dueBefore: instant(),
}).oxor('planId', 'noPlan');

const usageLimitsReport = Joi.object({
  ...reportCommon,
  limitKey: Joi.string().valid(...PLAN_LIMIT_KEYS),
  band: csvOf(USAGE_BANDS),
}).oxor('planId', 'noPlan');

const featureAvailabilityReport = Joi.object({
  ...reportCommon,
  featureKey: Joi.string().valid(...FEATURE_KEYS),
  state: Joi.string().valid(...FEATURE_STATES),
})
  .oxor('planId', 'noPlan')
  .with('state', 'featureKey');

const platformActivityReport = Joi.object({
  from: instant(),
  before: instant(),
  category: Joi.string().valid(...ACTIVITY_CATEGORIES),
});

// ---- analytics ----------------------------------------------------------------------------

const analyticsRange = {
  period: Joi.string().valid(...PERIODS),
  from: instant(),
  before: instant(),
};

const analyticsSummary = Joi.object({ ...analyticsRange });

const analyticsGrowth = Joi.object({
  ...analyticsRange,
  granularity: Joi.string().valid('day', 'week', 'month').default('day'),
});

const analyticsTenants = Joi.object({
  sort: Joi.string().valid('lastActivity', 'members', 'storage').default('lastActivity'),
  limit: limit(50),
});

const analyticsTenant = Joi.object({ ...analyticsRange });

module.exports = {
  validateStrict,
  instant,
  csvOf,
  REPORTABLE_LIFECYCLE,
  USAGE_BANDS,
  FEATURE_STATES,
  ACTIVITY_CATEGORIES,
  PERIODS,
  auditList,
  subscriptionsReport,
  usageLimitsReport,
  featureAvailabilityReport,
  platformActivityReport,
  analyticsSummary,
  analyticsGrowth,
  analyticsTenants,
  analyticsTenant,
};
