/**
 * Checkout and manual payment confirmation (Point 19 — BACKEND-HANDOFF.md §18.8).
 *
 *   POST /billing/checkout            the server quotes (never trusts client
 *                                     prices) and snapshots the quote into a
 *                                     BillingOrder `pending_payment`. NOTHING
 *                                     is redeemed here.
 *   POST /platform/billing/orders/:id/confirm
 *                                     a Super Admin confirms the manual
 *                                     payment; in ONE transaction the coupon is
 *                                     redeemed, the order is paid and the
 *                                     subscription is activated / renewed.
 */
const { DateTime } = require('luxon');
const AppError = require('../utils/appError');
const { BillingOrder, Coupon, CouponRedemption, SaasTenant, TenantTombstone, TenantStatusEvent } = require('../models');
const pricingService = require('./pricingService');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const { withTransaction } = require('./txn');
const { iso } = require('../utils/time');
const cursor = require('../utils/cursor');

const DEFAULT_PLAN_ID = 'mtm_standard';

const PAYMENT_INSTRUCTIONS =
  'تم إنشاء طلب الاشتراك وهو بانتظار الدفع. لإتمام الدفع، تواصل مع دعم ليدر عبر البريد الإلكتروني أو تيليغرام أو واتساب، واذكر رقم الطلب. يُفعَّل الاشتراك فور تأكيد الدفع.';

// ---- JSON --------------------------------------------------------------------------

const moneyJson = (m) => (m ? { amount: m.amount, currency: m.currency || 'USD' } : null);

const promotionJson = (p) => {
  if (!p || !p.source) return null;
  const out = { source: p.source, id: p.id, label: p.label || '' };
  if (p.code) out.code = p.code;
  return out;
};

/** Order JSON (tenant + platform). */
const orderJson = (o) => {
  const out = {
    id: String(o._id),
    billingOptionId: o.billingOptionId,
    months: o.months,
    basePrice: moneyJson(o.basePrice),
    finalPrice: moneyJson(o.finalPrice),
    promotion: promotionJson(o.promotion),
    planId: o.planId || null,
    status: o.status,
    createdAt: iso(o.createdAt),
  };
  if (o.paidAt) out.paidAt = iso(o.paidAt);
  if (o.cancelledAt) out.cancelledAt = iso(o.cancelledAt);
  return out;
};

/** Platform order JSON: + tenantId + tenantName (+ payment evidence). */
const platformOrderJson = (o, tenantName) => {
  const out = { ...orderJson(o), tenantId: o.tenantId, tenantName: tenantName || '' };
  if (o.paymentReference) out.paymentReference = o.paymentReference;
  if (o.confirmedBy && o.confirmedBy.accountId) out.confirmedBy = { accountId: o.confirmedBy.accountId, displayName: o.confirmedBy.displayName || '' };
  return out;
};

const subscriptionJson = (s) => {
  const overrides = s.limitOverrides instanceof Map ? Object.fromEntries(s.limitOverrides) : s.limitOverrides || {};
  const out = {
    status: s.status,
    planId: s.planId || null,
    version: s.version,
    trialEndsAt: iso(s.trialEndsAt),
    renewsAt: iso(s.renewsAt),
    graceEndsAt: iso(s.graceEndsAt),
    limitOverrides: overrides,
  };
  if (s.lastPayment && s.lastPayment.billingOrderId) {
    out.lastPayment = {
      billingOrderId: s.lastPayment.billingOrderId,
      billingOptionId: s.lastPayment.billingOptionId,
      amount: { amount: s.lastPayment.amount, currency: s.lastPayment.currency || 'USD' },
      paidAt: iso(s.lastPayment.paidAt),
    };
  }
  return out;
};

const tenantNames = async (tenantIds) => {
  const ids = [...new Set(tenantIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const [tenants, tombstones] = await Promise.all([
    SaasTenant.find({ _id: { $in: ids } }).select('_id displayName'),
    TenantTombstone.find({ _id: { $in: ids } }).select('_id displayNameSnapshot'),
  ]);
  const map = new Map(tombstones.map((t) => [String(t._id), t.displayNameSnapshot]));
  tenants.forEach((t) => map.set(String(t._id), t.displayName));
  return map;
};

// ---- tenant side ----------------------------------------------------------------------

/**
 * Create a `pending_payment` order from a SERVER-computed quote.
 * Invalid coupon → the same refusal codes as /pricing/coupons/validate.
 */
const checkout = async ({ tenant, account, billingOptionId, couponCode }) => {
  const { quote } = await pricingService.quoteOption(billingOptionId, {
    couponCode,
    accountId: String(account._id),
    strict: true,
  });
  const order = await BillingOrder.create({
    tenantId: String(tenant._id),
    accountId: String(account._id),
    billingOptionId: quote.billingOptionId,
    months: quote.months,
    basePrice: quote.basePrice,
    finalPrice: quote.finalPrice,
    promotion: quote.promotion
      ? { source: quote.promotion.source, id: quote.promotion.id, code: quote.promotion.code, label: quote.promotion.label }
      : { source: null },
    planId: (tenant.subscription && tenant.subscription.planId) || DEFAULT_PLAN_ID,
    status: 'pending_payment',
  });
  const settings = await settingsService.get();
  return {
    order: orderJson(order),
    payment: {
      provider: 'manual',
      status: 'pending_payment',
      instructions: PAYMENT_INSTRUCTIONS,
      support: {
        email: (settings.support && settings.support.email) || '',
        telegram: (settings.support && settings.support.telegram) || '',
        whatsapp: (settings.support && settings.support.whatsapp) || '',
      },
    },
  };
};

const tenantOrders = async (tenantId) => {
  const orders = await BillingOrder.find({ tenantId }).sort({ createdAt: -1, _id: -1 });
  return orders.map(orderJson);
};

const tenantOrder = async (tenantId, orderId) => {
  const order = await BillingOrder.findOne({ _id: orderId, tenantId });
  if (!order) throw AppError.notFound('billing order');
  return orderJson(order);
};

// ---- platform side ------------------------------------------------------------------------

const listOrders = async ({ status, tenantId, cursor: rawCursor, limit = 50 }) => {
  const filter = {};
  if (status) filter.status = status;
  if (tenantId) filter.tenantId = tenantId;
  const c = cursor.decode(rawCursor);
  if (c) {
    const at = new Date(c.t);
    filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: c.id } }];
  }
  const rows = await BillingOrder.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const names = await tenantNames(page.map((o) => o.tenantId));
  const last = page[page.length - 1];
  return {
    items: page.map((o) => platformOrderJson(o, names.get(o.tenantId))),
    nextCursor: rows.length > limit && last ? cursor.encode({ t: last.createdAt.toISOString(), id: String(last._id) }) : null,
  };
};

const platformOrder = async (orderId) => {
  const order = await BillingOrder.findById(orderId);
  if (!order) throw AppError.notFound('billing order');
  const names = await tenantNames([order.tenantId]);
  return platformOrderJson(order, names.get(order.tenantId));
};

const notPending = (order) =>
  AppError.conflict(`The order is ${order.status}; only a pending_payment order can change.`, { orderStatus: order.status });

/** Renewal base: extend a running paid period, otherwise start now. */
const renewalBase = (subscription, now) => {
  const current = subscription && subscription.renewsAt ? new Date(subscription.renewsAt) : null;
  if (subscription && subscription.status === 'active' && current && current > now) return current;
  return now;
};

/**
 * Confirm a manual payment. Atomically: redeem the coupon (re-checking
 * maxUses), mark the order paid, activate/renew the subscription, append the
 * status event and the audit evidence.
 */
const confirmOrder = async ({ orderId, actor, paymentReference }) =>
  withTransaction(async (session) => {
    const now = new Date();
    const order = await BillingOrder.findById(orderId).session(session);
    if (!order) throw AppError.notFound('billing order');
    if (order.status !== 'pending_payment') throw notPending(order);

    const tenant = await SaasTenant.findById(order.tenantId).session(session);
    if (!tenant) throw AppError.conflict('The team of this order no longer exists.');
    const tenantRef = { id: String(tenant._id), displayName: tenant.displayName };

    // 1. Redeem the coupon — only now, only at payment.
    if (order.promotion && order.promotion.source === 'coupon' && order.promotion.id) {
      const couponId = order.promotion.id;
      const redeemed = await Coupon.findOneAndUpdate(
        {
          _id: couponId,
          $or: [{ maxUses: null }, { maxUses: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }],
        },
        { $inc: { usedCount: 1 } },
        { new: true, session },
      );
      if (!redeemed) {
        const exists = await Coupon.exists({ _id: couponId }).session(session);
        if (exists) throw new AppError('coupon_exhausted', 409, 'The coupon has no uses left.');
        // A coupon removed after checkout: the customer paid the snapshotted
        // price, so the redemption is still recorded against the order.
      }
      await CouponRedemption.create(
        [{ couponId, code: order.promotion.code, accountId: order.accountId, tenantId: order.tenantId, billingOrderId: String(order._id), redeemedAt: now }],
        { session },
      );
      await auditService.record({
        action: 'commerce_coupon_redeemed',
        actor,
        target: { type: 'coupon', id: couponId, displayName: order.promotion.code || '' },
        tenant: tenantRef,
        session,
      });
    }

    // 2. The order is paid (conditional: a concurrent confirm/cancel loses).
    const paid = await BillingOrder.findOneAndUpdate(
      { _id: order._id, status: 'pending_payment' },
      {
        $set: {
          status: 'paid',
          paidAt: now,
          confirmedBy: { accountId: String(actor._id), displayName: actor.name || '' },
          paymentReference: paymentReference || null,
        },
      },
      { new: true, session },
    );
    if (!paid) throw notPending(order);

    // 3. Activate / renew the subscription and snapshot the price paid.
    const before = tenant.subscription.status;
    const beforePlan = tenant.subscription.planId || null;
    const renewsAt = DateTime.fromJSDate(renewalBase(tenant.subscription, now)).plus({ months: order.months }).toJSDate();
    tenant.subscription.status = 'active';
    tenant.subscription.planId = order.planId || DEFAULT_PLAN_ID;
    tenant.subscription.renewsAt = renewsAt;
    tenant.subscription.trialEndsAt = null;
    tenant.subscription.graceEndsAt = null;
    tenant.subscription.version = (tenant.subscription.version || 1) + 1;
    tenant.subscription.lastPayment = {
      billingOrderId: String(order._id),
      billingOptionId: order.billingOptionId,
      amount: order.finalPrice.amount,
      currency: order.finalPrice.currency || 'USD',
      paidAt: now,
    };
    await tenant.save({ session });

    await TenantStatusEvent.create([{ tenantId: String(tenant._id), type: 'subscription_activated', occurredAt: now }], { session });

    const changes = [{ field: 'billing_order_status', before: 'pending_payment', after: 'paid' }];
    if (before !== 'active') changes.push({ field: 'subscription_status', before, after: 'active' });
    if (beforePlan !== tenant.subscription.planId) changes.push({ field: 'plan_assignment', before: beforePlan, after: tenant.subscription.planId });
    await auditService.record({
      action: 'billing_order_paid',
      actor,
      target: { type: 'billing_order', id: String(order._id) },
      tenant: tenantRef,
      changes,
      session,
    });

    return { order: platformOrderJson(paid, tenant.displayName), subscription: subscriptionJson(tenant.subscription) };
  });

const cancelOrder = async ({ orderId, actor }) =>
  withTransaction(async (session) => {
    const order = await BillingOrder.findById(orderId).session(session);
    if (!order) throw AppError.notFound('billing order');
    if (order.status !== 'pending_payment') throw notPending(order);
    const cancelled = await BillingOrder.findOneAndUpdate(
      { _id: order._id, status: 'pending_payment' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { new: true, session },
    );
    if (!cancelled) throw notPending(order);
    const names = await tenantNames([order.tenantId]);
    await auditService.record({
      action: 'billing_order_cancelled',
      actor,
      target: { type: 'billing_order', id: String(order._id) },
      tenant: { id: order.tenantId, displayName: names.get(order.tenantId) || '' },
      changes: [{ field: 'billing_order_status', before: 'pending_payment', after: 'cancelled' }],
      session,
    });
    return platformOrderJson(cancelled, names.get(order.tenantId));
  });

module.exports = {
  PAYMENT_INSTRUCTIONS,
  orderJson,
  platformOrderJson,
  subscriptionJson,
  checkout,
  tenantOrders,
  tenantOrder,
  listOrders,
  platformOrder,
  confirmOrder,
  cancelOrder,
};
