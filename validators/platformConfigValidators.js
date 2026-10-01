/**
 * Joi schemas for platform configuration: /platform/plans, /platform/settings,
 * /platform/admins and /platform/accounts.
 */
const Joi = require('joi');
const { IANAZone } = require('luxon');
const { PLAN_LIMIT_KEYS, ROLES, ACCOUNT_STATUS, DISPLAY_NAME_MAX, REASON_MAX } = require('../config/constants');
const { collapse, isEmail, email: normEmail } = require('../utils/normalize');

const PLAN_ID_RE = /^[a-z0-9_]{3,40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const collapsed = (max, label) =>
  Joi.string().custom((value, helpers) => {
    const v = collapse(value);
    if (!v || v.length > max) return helpers.message(`${label} must be 1–${max} characters.`);
    return v;
  });

const emailField = Joi.string().custom((value, helpers) =>
  isEmail(value) ? normEmail(value) : helpers.message('A valid email address is required.'),
);

const limitValue = Joi.number().integer().min(0).strict();

// ---- plans -----------------------------------------------------------------------------------

const fullLimits = Joi.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, limitValue.required()])));
const partialLimits = Joi.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, limitValue]))).min(1);

const createPlan = Joi.object({
  id: Joi.string().pattern(PLAN_ID_RE).required().messages({ 'string.pattern.base': 'id must be 3–40 lowercase letters, digits or underscores.' }),
  name: collapsed(80, 'name').required(),
  description: Joi.string().allow('').max(500).default(''),
  recommended: Joi.boolean().default(false),
  selectable: Joi.boolean().default(true),
  defaultLimits: fullLimits.required(),
});

const updatePlan = Joi.object({
  name: collapsed(80, 'name'),
  description: Joi.string().allow('').max(500),
  recommended: Joi.boolean(),
  selectable: Joi.boolean(),
  defaultLimits: partialLimits,
}).min(1);

// ---- settings ------------------------------------------------------------------------------------

const int = (min, max) => Joi.number().integer().min(min).max(max);

const updateSettings = Joi.object({
  minimumClientVersion: Joi.string().trim().pattern(SEMVER_RE).messages({ 'string.pattern.base': 'minimumClientVersion must be a semantic version such as 1.4.0.' }),
  defaultTimezone: Joi.string().custom((value, helpers) =>
    IANAZone.isValidZone(value) ? value : helpers.message('defaultTimezone must be an IANA zone such as Asia/Damascus.'),
  ),
  trialDays: int(1, 365),
  graceDays: int(0, 365),
  deletionWindowDays: int(0, 365),
  breakGlassMinutes: int(5, 1440),
  invitationDays: int(1, 90),
  idempotencyRetentionDays: int(1, 90),
  attendanceGraceMinutes: int(0, 1440),
  recentAuthMinutes: int(1, 1440),
  otp: Joi.object({
    length: int(4, 10),
    ttlMinutes: int(1, 60),
    maxAttempts: int(1, 20),
    resendCooldownSeconds: int(0, 3600),
  }).min(1),
  signInLockout: Joi.object({
    maxFailures: int(1, 100),
    windowMinutes: int(1, 1440),
  }).min(1),
  support: Joi.object({
    email: Joi.alternatives().try(Joi.string().valid(''), emailField),
    telegram: Joi.string().allow('').trim().max(200),
    whatsapp: Joi.string().allow('').trim().max(200),
  }).min(1),
}).min(1);

// ---- platform admins ---------------------------------------------------------------------------------

const createAdmin = Joi.object({
  name: collapsed(DISPLAY_NAME_MAX, 'name').required(),
  email: emailField.required(),
  password: Joi.string().min(8).max(128).required(),
});

const suspendAdmin = Joi.object({ reason: collapsed(REASON_MAX, 'reason').required() });

// ---- accounts lookup -------------------------------------------------------------------------------

const listAccountsQuery = Joi.object({
  search: Joi.string().allow('').trim().max(200),
  role: Joi.string().valid(...Object.values(ROLES)),
  tenantId: Joi.string().trim().max(80),
  status: Joi.string().valid(...ACCOUNT_STATUS),
  cursor: Joi.string().allow('').max(500),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

module.exports = {
  PLAN_ID_RE,
  SEMVER_RE,
  createPlan,
  updatePlan,
  updateSettings,
  createAdmin,
  suspendAdmin,
  listAccountsQuery,
};
