/**
 * Commerce pricing (Point 19 — BACKEND-HANDOFF.md §18).
 *
 * One product, four billing durations, two promotion mechanisms that NEVER
 * stack. Everything a client renders is a preview of what this module answers.
 *
 *   percentage      discount = floor((base * pct + 50) / 100)   (half-up ON THE DISCOUNT)
 *                   final    = base − discount                   (1400 @ 10% → 1260)
 *   fixed price     final    = finalPrice.amount                 («first month for $2» = 200)
 *
 * A promotion is SANE for an option iff the option is promotion-eligible
 * (policy data: PROMOTION_ELIGIBLE_OPTIONS), a percentage is 1–90, and
 * 0 < final < base. No stacking: the lower final price wins; an exact tie goes
 * to the global offer.
 *
 * The first half of the file is pure (no I/O) so it can be unit-tested to the
 * cent; the second half reads offers/coupons.
 */
const AppError = require('../utils/appError');
const { BILLING_OPTIONS, PROMOTION_ELIGIBLE_OPTIONS, CURRENCY } = require('../config/constants');
const { normalizeCouponCode } = require('../utils/normalize');
const { iso } = require('../utils/time');

// ---- pure ------------------------------------------------------------------------

const OPTION_IDS = BILLING_OPTIONS.map((o) => o.id);

const optionById = (id) => BILLING_OPTIONS.find((o) => o.id === id) || null;

const money = (amount) => ({ amount, currency: CURRENCY });

/** Policy data, not a hard-coded branch: the eligible set lives in config. */
const isPromotionEligible = (optionId) => PROMOTION_ELIGIBLE_OPTIONS.includes(optionId);

/** The monthly base price every duration's savings are measured against. */
const monthlyBase = () => optionById('monthly').basePrice;

/** Half-up on the discount, then subtract (the Dart twin: percentageDiscount). */
const percentageFinal = (base, percent) => base - Math.floor((base * percent + 50) / 100);

/** Final amount a discount yields on `base` (no sanity check). */
const applyDiscount = (discount, base) => {
  if (!discount) return base;
  if (discount.kind === 'percentage') return percentageFinal(base, discount.percent);
  if (discount.kind === 'fixed_final_price') return discount.finalPrice ? discount.finalPrice.amount : NaN;
  return NaN;
};

/** Sane for a base price: percent 1–90 (integer) and 0 < final < base. */
const isSaneFor = (discount, base) => {
  if (!discount) return false;
  if (discount.kind === 'percentage') {
    const p = discount.percent;
    if (!Number.isInteger(p) || p < 1 || p > 90) return false;
  } else if (discount.kind === 'fixed_final_price') {
    if (!discount.finalPrice || !Number.isInteger(discount.finalPrice.amount)) return false;
    if (discount.finalPrice.currency && discount.finalPrice.currency !== CURRENCY) return false;
  } else {
    return false;
  }
  const final = applyDiscount(discount, base);
  return Number.isInteger(final) && final > 0 && final < base;
};

/** Sane for an option = eligible AND sane for its base price. */
const isSaneForOption = (optionId, discount) => {
  const option = optionById(optionId);
  return !!option && isPromotionEligible(optionId) && isSaneFor(discount, option.basePrice);
};

/** Display-only monthly equivalent, rounded half-up (Dart: effectiveMonthlyPrice). */
const effectiveMonthly = (total, months) => Math.floor((total + Math.floor(months / 2)) / months);

/** Savings versus paying the monthly base for the same duration (never negative). */
const durationSavings = (final, months) => Math.max(0, monthlyBase() * months - final);

/** Wire Discount JSON. */
const discountJson = (d) => {
  if (!d) return null;
  if (d.kind === 'percentage') return { kind: 'percentage', percent: d.percent };
  return { kind: 'fixed_final_price', finalPrice: money(d.finalPrice.amount) };
};

/** Plain discount (for persistence) from validated input. */
const discountDoc = (d) =>
  d.kind === 'percentage'
    ? { kind: 'percentage', percent: d.percent }
    : { kind: 'fixed_final_price', finalPrice: { amount: d.finalPrice.amount, currency: CURRENCY } };

const offerLabel = (offer) => (offer.title ? offer.title : 'global_offer');

/**
 * Build one PriceQuote.
 *
 * @param option  a BILLING_OPTIONS entry
 * @param opts.offer   live GlobalOffer for this option (or null)
 * @param opts.coupon  a VALID coupon targeting this option (or null)
 * @returns {{ quote, couponOutcome: 'applied'|'global_offer_is_better'|null }}
 */
const buildQuote = (option, { offer = null, coupon = null } = {}) => {
  const base = option.basePrice;
  let final = base;
  let promotion = null;
  let couponOutcome = null;

  if (offer && isPromotionEligible(option.id) && isSaneFor(offer.discount, base)) {
    final = applyDiscount(offer.discount, base);
    promotion = { source: 'global_offer', id: String(offer._id || offer.id), label: offerLabel(offer) };
  }

  if (coupon && coupon.target === option.id && isSaneFor(coupon.discount, base)) {
    const couponFinal = applyDiscount(coupon.discount, base);
    // Strictly lower wins; an exact tie deliberately stays with the global offer.
    if (!promotion || couponFinal < final) {
      final = couponFinal;
      promotion = { source: 'coupon', id: String(coupon._id || coupon.id), code: coupon.code, label: coupon.code };
      couponOutcome = 'applied';
    } else {
      couponOutcome = 'global_offer_is_better';
    }
  }

  const quote = {
    billingOptionId: option.id,
    months: option.months,
    basePrice: money(base),
    finalPrice: money(final),
    durationSavings: money(durationSavings(final, option.months)),
    promotionSavings: money(base - final),
    effectiveMonthly: money(effectiveMonthly(final, option.months)),
  };
  if (promotion) quote.promotion = promotion;
  return { quote, couponOutcome };
};

// ---- catalogue ----------------------------------------------------------------------

const catalogOptions = () =>
  BILLING_OPTIONS.map((o) => ({
    id: o.id,
    months: o.months,
    basePrice: money(o.basePrice),
    effectiveMonthly: money(effectiveMonthly(o.basePrice, o.months)),
    promotionEligible: isPromotionEligible(o.id),
    grantsFullAccess: true,
  }));

// ---- offers & coupons (I/O) ------------------------------------------------------------

const liveFilter = (field, now) => ({ $or: [{ [field]: null }, { [field]: { $exists: false } }, { [field]: { $gt: now } }] });

/**
 * Live, sane offers on eligible options — the FIRST live offer per target
 * (oldest first), keyed by option id.
 */
const liveOffersByTarget = async (now = new Date()) => {
  const { GlobalOffer } = require('../models');
  const offers = await GlobalOffer.find({ enabled: true, ...liveFilter('endsAt', now) }).sort({ createdAt: 1, _id: 1 });
  const byTarget = new Map();
  offers.forEach((o) => {
    if (byTarget.has(o.target)) return;
    if (!isSaneForOption(o.target, o.discount)) return;
    byTarget.set(o.target, o);
  });
  return byTarget;
};

/** Public projection of a live offer (GET /pricing/offers/active). */
const activeOfferJson = (o) => ({
  id: String(o._id),
  target: o.target,
  discount: discountJson(o.discount),
  title: o.title || null,
  endsAt: iso(o.endsAt),
});

const couponError = (code, message, extensions) => new AppError(code, 422, message, extensions);

/**
 * Validate a coupon for `accountId` — a READ. Never consumes, reserves or
 * decrements anything. Refusals in the contract order (§18.6):
 * not_found → disabled → expired → not_assigned → not_eligible → exhausted →
 * invalid_price.
 *
 * @returns the Coupon document
 */
const resolveCoupon = async (rawCode, accountId, now = new Date()) => {
  const { Coupon } = require('../models');
  const code = normalizeCouponCode(rawCode);
  if (!code) throw couponError('coupon_not_found', 'No coupon matches this code.');
  const coupon = await Coupon.findOne({ code });
  if (!coupon) throw couponError('coupon_not_found', 'No coupon matches this code.');
  if (!coupon.enabled) throw couponError('coupon_disabled', 'This coupon is not enabled.');
  if (coupon.expiresAt && now >= coupon.expiresAt) throw couponError('coupon_expired', 'This coupon has expired.');
  if (coupon.assignment && coupon.assignment.kind === 'account' && coupon.assignment.accountId !== String(accountId)) {
    throw couponError('coupon_not_assigned', 'This coupon is assigned to another account.');
  }
  if (!isPromotionEligible(coupon.target)) throw couponError('coupon_not_eligible', 'This billing option takes no discount.');
  if (coupon.maxUses !== null && coupon.maxUses !== undefined && coupon.usedCount >= coupon.maxUses) {
    throw couponError('coupon_exhausted', 'This coupon has no uses left.');
  }
  if (!isSaneForOption(coupon.target, coupon.discount)) throw couponError('coupon_invalid_price', 'This coupon does not produce a valid price.');
  return coupon;
};

/** The coupon applies to a different duration than the one being bought. */
const couponOtherOption = (coupon) =>
  couponError('coupon_not_eligible', 'This coupon applies to a different billing option.', { couponTarget: coupon.target });

/** Quotes for every option with live offers applied (no coupon). */
const allQuotes = async (now = new Date()) => {
  const offers = await liveOffersByTarget(now);
  return BILLING_OPTIONS.map((o) => buildQuote(o, { offer: offers.get(o.id) || null }).quote);
};

/**
 * Quote one option for `accountId`, resolving the best of the live offer and
 * an optional coupon.
 *
 * @param opts.strict  true (checkout): an invalid coupon THROWS its refusal code.
 *                     false (preview): it is reported as couponOutcome 'invalid'.
 * @returns {{ quote, couponOutcome?, couponError?, coupon? }}
 */
const quoteOption = async (optionId, { couponCode, accountId, strict = false, now = new Date() } = {}) => {
  const option = optionById(optionId);
  if (!option) throw AppError.validation({ billingOptionId: 'Unknown billing option.' });
  const offers = await liveOffersByTarget(now);
  const offer = offers.get(option.id) || null;
  const hasCode = typeof couponCode === 'string' && couponCode.trim() !== '';
  if (!hasCode) return { quote: buildQuote(option, { offer }).quote };

  let coupon;
  try {
    coupon = await resolveCoupon(couponCode, accountId, now);
    if (coupon.target !== option.id) throw couponOtherOption(coupon);
  } catch (err) {
    if (strict || !(err instanceof AppError)) throw err;
    const out = { quote: buildQuote(option, { offer }).quote, couponOutcome: 'invalid', couponError: err.code };
    if (err.extensions && err.extensions.couponTarget) out.couponTarget = err.extensions.couponTarget;
    return out;
  }
  const { quote, couponOutcome } = buildQuote(option, { offer, coupon });
  return { quote, couponOutcome, coupon };
};

// ---- platform projections ------------------------------------------------------------------

const offerJson = (o, now = new Date()) => ({
  id: String(o._id),
  enabled: !!o.enabled,
  live: o.isLiveAt(now),
  target: o.target,
  discount: discountJson(o.discount),
  title: o.title || null,
  endsAt: iso(o.endsAt),
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
});

/** Platform coupon JSON. `note` is platform-only — never use this for a tenant caller. */
const couponJson = (c, emails = new Map(), now = new Date()) => {
  const assignment = { kind: (c.assignment && c.assignment.kind) || 'public' };
  if (assignment.kind === 'account') {
    assignment.accountId = c.assignment.accountId;
    const email = emails.get(c.assignment.accountId);
    if (email) assignment.accountEmail = email;
  }
  return {
    id: String(c._id),
    code: c.code,
    enabled: !!c.enabled,
    live: c.isLiveAt(now),
    target: c.target,
    discount: discountJson(c.discount),
    assignment,
    note: c.note || null,
    expiresAt: iso(c.expiresAt),
    maxUses: c.maxUses === undefined ? null : c.maxUses,
    usedCount: c.usedCount || 0,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
};

module.exports = {
  OPTION_IDS,
  optionById,
  money,
  isPromotionEligible,
  monthlyBase,
  percentageFinal,
  applyDiscount,
  isSaneFor,
  isSaneForOption,
  effectiveMonthly,
  durationSavings,
  discountJson,
  discountDoc,
  buildQuote,
  catalogOptions,
  liveOffersByTarget,
  activeOfferJson,
  resolveCoupon,
  allQuotes,
  quoteOption,
  offerJson,
  couponJson,
};
