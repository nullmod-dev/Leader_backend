/**
 * Commerce (Point 19). Shape errors are `validation`; price SANITY (percent
 * 1–90, 0 < final < base, eligible target) is `promotion_invalid`, judged by
 * services/pricingService, and coupon-code shape is `coupon_code_invalid`.
 */
const Joi = require('joi');
const { BILLING_OPTIONS } = require('../config/constants');
const { parseInstant } = require('../utils/time');

const OPTION_IDS = BILLING_OPTIONS.map((o) => o.id);

const optionId = Joi.string().valid(...OPTION_IDS);

/** An RFC 3339 instant (no offset → UTC on the control plane) → Date. */
const instant = Joi.string()
  .trim()
  .custom((value, helpers) => {
    const d = parseInstant(value, 'UTC');
    return d || helpers.error('any.invalid');
  }, 'instant')
  .messages({ 'any.invalid': '{{#label}} must be an RFC 3339 instant.' });

const money = Joi.object({
  amount: Joi.number().integer().required(),
  currency: Joi.string().valid('USD').default('USD'),
});

const discount = Joi.object({
  kind: Joi.string().valid('percentage', 'fixed_final_price').required(),
  percent: Joi.when('kind', { is: 'percentage', then: Joi.number().integer().required(), otherwise: Joi.any().strip() }),
  finalPrice: Joi.when('kind', { is: 'fixed_final_price', then: money.required(), otherwise: Joi.any().strip() }),
});

const assignment = Joi.object({
  kind: Joi.string().valid('public', 'account').required(),
  accountId: Joi.string().trim().max(64).allow('', null),
  email: Joi.string().trim().max(254).allow('', null),
});

const title = Joi.string().trim().max(120).allow('', null);
const note = Joi.string().trim().max(500).allow('', null);
const couponCodeInput = Joi.string().max(64);

// ---- /pricing + /billing -----------------------------------------------------------

const quote = Joi.object({
  billingOptionId: optionId.required(),
  couponCode: couponCodeInput.allow('', null),
});

const validateCoupon = Joi.object({
  code: couponCodeInput.allow('').required(),
  billingOptionId: optionId,
});

const checkout = Joi.object({
  billingOptionId: optionId.required(),
  couponCode: couponCodeInput.allow('', null),
});

// ---- /platform/commerce ------------------------------------------------------------------

const offerCreate = Joi.object({
  target: optionId.required(),
  discount: discount.required(),
  title,
  endsAt: instant.allow(null),
  enabled: Joi.boolean().default(false),
});

const offerPatch = Joi.object({
  target: optionId,
  discount,
  title,
  endsAt: instant.allow(null),
  enabled: Joi.boolean(),
}).min(1);

const couponCreate = Joi.object({
  code: couponCodeInput.required(),
  target: optionId.required(),
  discount: discount.required(),
  assignment: assignment.default({ kind: 'public' }),
  note,
  expiresAt: instant.allow(null),
  maxUses: Joi.number().integer().min(1).allow(null),
  enabled: Joi.boolean().default(false),
});

const couponPatch = Joi.object({
  code: couponCodeInput,
  target: optionId,
  discount,
  assignment,
  note,
  expiresAt: instant.allow(null),
  maxUses: Joi.number().integer().min(1).allow(null),
  enabled: Joi.boolean(),
}).min(1);

// ---- /platform/billing ----------------------------------------------------------------------

const ordersQuery = Joi.object({
  status: Joi.string().valid('pending_payment', 'paid', 'cancelled'),
  tenantId: Joi.string().trim().max(64),
  cursor: Joi.string().max(1024),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

const confirm = Joi.object({
  paymentReference: Joi.string().trim().max(120).allow('', null),
});

module.exports = {
  quote,
  validateCoupon,
  checkout,
  offerCreate,
  offerPatch,
  couponCreate,
  couponPatch,
  ordersQuery,
  confirm,
};
