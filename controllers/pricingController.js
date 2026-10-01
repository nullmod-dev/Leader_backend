/**
 * /pricing — the commercial catalogue and quotes (Point 19).
 * Flutter: /more/pricing (pricing page, coupon field, subscription contact).
 * Reads need no capability; a Customer Demo session may view and validate.
 */
const catchAsync = require('../utils/catchAsyncErrors');
const pricingService = require('../services/pricingService');
const settingsService = require('../services/settingsService');
const { CURRENCY } = require('../config/constants');

const supportOf = (settings) => ({
  email: (settings.support && settings.support.email) || '',
  telegram: (settings.support && settings.support.telegram) || '',
  whatsapp: (settings.support && settings.support.whatsapp) || '',
});

/** GET /catalog — public */
exports.catalog = catchAsync(async (req, res) => {
  const settings = await settingsService.get();
  res.json({ currency: CURRENCY, options: pricingService.catalogOptions(), support: supportOf(settings) });
});

/** GET /offers/active — public → [ActiveOffer] */
exports.activeOffers = catchAsync(async (req, res) => {
  const offers = await pricingService.liveOffersByTarget();
  res.json([...offers.values()].map(pricingService.activeOfferJson));
});

/** GET /quotes — optional auth → [PriceQuote] (live offers, no coupon) */
exports.quotes = catchAsync(async (req, res) => {
  res.json(await pricingService.allQuotes());
});

/** POST /quote → PriceQuote (+ couponOutcome / couponError when a code was sent) */
exports.quote = catchAsync(async (req, res) => {
  const { quote, couponOutcome, couponError, couponTarget } = await pricingService.quoteOption(req.body.billingOptionId, {
    couponCode: req.body.couponCode,
    accountId: String(req.auth.account._id),
  });
  const out = { ...quote };
  if (couponOutcome) out.couponOutcome = couponOutcome;
  if (couponError) out.couponError = couponError;
  if (couponTarget) out.couponTarget = couponTarget;
  res.json(out);
});

/** POST /coupons/validate — VALIDATION ONLY: never consumes, reserves or decrements. */
exports.validateCoupon = catchAsync(async (req, res) => {
  const accountId = String(req.auth.account._id);
  const coupon = await pricingService.resolveCoupon(req.body.code, accountId);
  const { quote, couponOutcome } = await pricingService.quoteOption(coupon.target, { couponCode: coupon.code, accountId, strict: true });
  res.json({
    valid: true,
    coupon: { code: coupon.code, target: coupon.target },
    quote,
    couponOutcome,
    appliesToSelected: req.body.billingOptionId ? req.body.billingOptionId === coupon.target : true,
  });
});
