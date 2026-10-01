/**
 * Commerce (Point 19): one full-access product, four billing durations, two
 * promotion mechanisms that NEVER stack.
 *
 *  - GlobalOffer  — enabled by a Super Admin, seen by everyone, no code.
 *                   At most one LIVE offer per billing option.
 *  - Coupon       — code-based; public, or targeted to one ACCOUNT ID.
 *  - BillingOrder — a checkout quote snapshot. Payment is confirmed by a Super
 *                   Admin (manual provider) and ONLY then is a coupon redeemed
 *                   and the subscription activated/renewed.
 *
 * Money is always integer minor units + explicit currency: { amount, currency }.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { BILLING_OPTIONS } = require('../config/constants');

const OPTION_IDS = BILLING_OPTIONS.map((o) => o.id);

const moneySchema = new mongoose.Schema(
  { amount: { type: Number, required: true, min: 0 }, currency: { type: String, default: 'USD' } },
  { _id: false },
);

const discountSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['percentage', 'fixed_final_price'], required: true },
    percent: { type: Number, min: 1, max: 90 },
    finalPrice: moneySchema,
  },
  { _id: false },
);

// ---- GlobalOffer -------------------------------------------------------------
const globalOfferSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    target: { type: String, enum: OPTION_IDS, required: true },
    discount: { type: discountSchema, required: true },
    title: { type: String, default: null },
    endsAt: { type: Date, default: null },
    createdBy: { accountId: String, displayName: String },
  },
  { timestamps: true, collection: 'global_offers' },
);
globalOfferSchema.plugin(basePlugin, { prefix: 'offer', hideTenantId: false });
globalOfferSchema.methods.isLiveAt = function isLiveAt(now = new Date()) {
  return this.enabled && (!this.endsAt || now < this.endsAt);
};

// ---- Coupon ------------------------------------------------------------------
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // normalized ^[A-Z0-9-]{3,24}$
    enabled: { type: Boolean, default: false },
    target: { type: String, enum: OPTION_IDS, required: true },
    discount: { type: discountSchema, required: true },
    assignment: {
      kind: { type: String, enum: ['public', 'account'], default: 'public' },
      accountId: { type: String, default: null },
    },
    note: { type: String, default: null }, // internal — never returned to non-platform callers
    expiresAt: { type: Date, default: null },
    maxUses: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0 },
    createdBy: { accountId: String, displayName: String },
  },
  { timestamps: true, collection: 'coupons' },
);
couponSchema.plugin(basePlugin, { prefix: 'coupon', hideTenantId: false });
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.methods.isLiveAt = function isLiveAt(now = new Date()) {
  return this.enabled && (!this.expiresAt || now < this.expiresAt);
};

// ---- BillingOrder --------------------------------------------------------------
const billingOrderSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    accountId: { type: String, required: true },
    billingOptionId: { type: String, enum: OPTION_IDS, required: true },
    months: { type: Number, required: true },
    basePrice: { type: moneySchema, required: true },
    finalPrice: { type: moneySchema, required: true },
    promotion: {
      source: { type: String, enum: ['global_offer', 'coupon', null], default: null },
      id: String,
      code: String,
      label: String,
    },
    planId: { type: String, default: null },
    status: { type: String, enum: ['pending_payment', 'paid', 'cancelled'], default: 'pending_payment' },
    paidAt: Date,
    cancelledAt: Date,
    confirmedBy: { accountId: String, displayName: String },
    paymentReference: { type: String, default: null },
  },
  { timestamps: true, collection: 'billing_orders' },
);
billingOrderSchema.plugin(basePlugin, { prefix: 'bo', hideTenantId: false });
billingOrderSchema.index({ status: 1, createdAt: -1 });

// ---- CouponRedemption ------------------------------------------------------------
const couponRedemptionSchema = new mongoose.Schema(
  {
    couponId: { type: String, required: true, index: true },
    code: String,
    accountId: String,
    tenantId: String,
    billingOrderId: { type: String, required: true, unique: true },
    redeemedAt: { type: Date, default: Date.now },
  },
  { collection: 'coupon_redemptions' },
);
couponRedemptionSchema.plugin(basePlugin, { prefix: 'red', hideTenantId: false });

module.exports = {
  GlobalOffer: mongoose.models.GlobalOffer || mongoose.model('GlobalOffer', globalOfferSchema),
  Coupon: mongoose.models.Coupon || mongoose.model('Coupon', couponSchema),
  BillingOrder: mongoose.models.BillingOrder || mongoose.model('BillingOrder', billingOrderSchema),
  CouponRedemption: mongoose.models.CouponRedemption || mongoose.model('CouponRedemption', couponRedemptionSchema),
};
