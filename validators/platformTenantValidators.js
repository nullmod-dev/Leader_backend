/**
 * Joi schemas for /platform/tenants/** (tenants, lifecycle, subscription,
 * limits, features, Main Admin seat).
 *
 * Feature-owned refusals are NOT expressed here: reasons (invalid_lifecycle_reason,
 * invalid_main_admin_reason), limit values (limit_invalid), trial dates
 * (invalid_trial_extension) and designate identities (invalid_main_admin_identity)
 * pass through as `any` and are judged by the controller/service so the client
 * receives the typed code rather than a generic `validation`.
 */
const Joi = require('joi');
const { IANAZone } = require('luxon');
const { DISPLAY_NAME_MAX } = require('../config/constants');
const { collapse, isEmail, email: normEmail, normalizeTeamCode } = require('../utils/normalize');

const LIST_STATUSES = ['trial', 'active', 'grace', 'inactive', 'suspended', 'deletion_pending'];

const version = Joi.number().integer().min(1).required();

/** 1–80 chars after whitespace collapse; the collapsed value replaces the input. */
const displayName = (label) =>
  Joi.string()
    .required()
    .custom((value, helpers) => {
      const v = collapse(value);
      if (!v || v.length > DISPLAY_NAME_MAX) return helpers.message(`${label} must be 1–${DISPLAY_NAME_MAX} characters.`);
      return v;
    });

const emailField = Joi.string()
  .required()
  .custom((value, helpers) => (isEmail(value) ? normEmail(value) : helpers.message('A valid email address is required.')));

const timezone = Joi.string().custom((value, helpers) =>
  IANAZone.isValidZone(value) ? value : helpers.message('timezone must be an IANA zone such as Asia/Damascus.'),
);

// ---- tenants -----------------------------------------------------------------------------

const listTenantsQuery = Joi.object({
  search: Joi.string().allow('').max(200),
  status: Joi.string().valid(...LIST_STATUSES),
  cursor: Joi.string().allow('').max(500),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

const createTenant = Joi.object({
  displayName: displayName('displayName'),
  mainAdminName: displayName('mainAdminName'),
  mainAdminEmail: emailField,
  teamCode: Joi.string()
    .allow(null, '')
    .custom((value, helpers) => {
      if (value === null || value === '') return value;
      const code = normalizeTeamCode(value);
      return code || helpers.message('teamCode must look like MTM-XXXX-XXXX.');
    }),
  timezone,
});

// ---- lifecycle -----------------------------------------------------------------------------

const lifecycleWithReason = Joi.object({ reason: Joi.any(), expectedVersion: version });
const lifecycleVersionOnly = Joi.object({ expectedVersion: version });

// ---- subscription & limits -------------------------------------------------------------------

const planId = Joi.string().trim().min(1).max(40).required();

const activateSubscription = Joi.object({ planId, expectedVersion: version });
const extendTrial = Joi.object({ newEndsAt: Joi.date().iso().required(), expectedVersion: version });
const subscriptionVersionOnly = Joi.object({ expectedVersion: version });
const changePlan = Joi.object({ planId, expectedVersion: version });
const limitOverride = Joi.object({ overrideValue: Joi.any(), expectedVersion: version });

// ---- features ------------------------------------------------------------------------------

const featurePatch = Joi.object({ enabled: Joi.boolean().strict().required(), expectedVersion: version });

// ---- Main Admin seat --------------------------------------------------------------------------

const revision = Joi.number().integer().min(1).required();

const seatResend = Joi.object({ expectedRevision: revision, target: Joi.string().valid('current', 'replacement').default('current') });
const seatSuspend = Joi.object({ expectedRevision: revision, reason: Joi.any() });
const seatRevisionOnly = Joi.object({ expectedRevision: revision });
const seatReplace = Joi.object({
  expectedRevision: revision,
  designate: Joi.object({ displayName: Joi.any(), loginEmail: Joi.any() }).unknown(false).default({}),
  reason: Joi.any(),
});

module.exports = {
  LIST_STATUSES,
  listTenantsQuery,
  createTenant,
  lifecycleWithReason,
  lifecycleVersionOnly,
  activateSubscription,
  extendTrial,
  subscriptionVersionOnly,
  changePlan,
  limitOverride,
  featurePatch,
  seatResend,
  seatSuspend,
  seatRevisionOnly,
  seatReplace,
};
