/**
 * /platform/commerce — global offers and coupons (Point 19, §18.3).
 * Flutter: /platform/operations/commerce.
 *
 * Platform authority only (platformGuard). Price sanity is judged by
 * services/pricingService (`promotion_invalid`); at most ONE live offer per
 * billing option (`offer_conflict`); a targeted coupon stores an ACCOUNT ID —
 * an operator may type an email, the server resolves it.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { GlobalOffer, Coupon, Account } = require('../../models');
const pricingService = require('../../services/pricingService');
const auditService = require('../../services/auditService');
const { withTransaction } = require('../../services/txn');
const { normalizeCouponCode, email: normalizeEmail, collapse } = require('../../utils/normalize');

// ---- helpers ------------------------------------------------------------------------

const clean = (value) => {
  if (value === undefined) return undefined;
  const v = collapse(value);
  return v ? v : null;
};

const promotionInvalid = () =>
  new AppError('promotion_invalid', 422, 'The promotion must target an eligible option, use 1–90%, and price strictly between 0 and the base price.');

const assertPromotion = (target, discount) => {
  if (!pricingService.isSaneForOption(target, discount)) throw promotionInvalid();
};

const offerNotFound = () => new AppError('offer_not_found', 404, 'offer not found');
const couponNotFound = () => new AppError('coupon_not_found', 404, 'coupon not found');

const createdBy = (account) => ({ accountId: String(account._id), displayName: account.name || '' });

/** Another LIVE offer already targets this option → 409 offer_conflict. */
const assertNoOtherLiveOffer = async (target, offerId, session) => {
  const now = new Date();
  const others = await GlobalOffer.find({ _id: { $ne: offerId }, target, enabled: true }).session(session);
  if (others.some((o) => o.isLiveAt(now))) {
    throw new AppError('offer_conflict', 409, 'Another live offer already targets this billing option.');
  }
};

const offerTarget = (offer) => ({ type: 'global_offer', id: String(offer._id), displayName: offer.title || offer.target });
const couponTarget = (coupon) => ({ type: 'coupon', id: String(coupon._id), displayName: coupon.code });

const loadOffer = async (id) => {
  const offer = await GlobalOffer.findById(id);
  if (!offer) throw offerNotFound();
  return offer;
};

const loadCoupon = async (id) => {
  const coupon = await Coupon.findById(id);
  if (!coupon) throw couponNotFound();
  return coupon;
};

/** Resolve the assignment SERVER-SIDE; only the account id is stored. */
const resolveAssignment = async (assignment) => {
  if (!assignment || assignment.kind === 'public') return { kind: 'public', accountId: null };
  let account = null;
  if (assignment.accountId) account = await Account.findById(assignment.accountId);
  else if (assignment.email) account = await Account.findOne({ email: normalizeEmail(assignment.email) });
  else throw AppError.validation({ assignment: 'An account assignment needs an accountId or an email.' });
  if (!account || account.role === 'customer_demo') {
    throw AppError.validation({ assignment: 'No account matches this assignment.' });
  }
  return { kind: 'account', accountId: String(account._id) };
};

const emailsFor = async (coupons) => {
  const ids = [...new Set(coupons.filter((c) => c.assignment && c.assignment.kind === 'account').map((c) => c.assignment.accountId))];
  if (!ids.length) return new Map();
  const accounts = await Account.find({ _id: { $in: ids } }).select('_id email');
  return new Map(accounts.filter((a) => a.email).map((a) => [String(a._id), a.email]));
};

const couponOut = async (coupon) => pricingService.couponJson(coupon, await emailsFor([coupon]));

const mapDuplicate = (err) => {
  if (err && err.code === 11000) return new AppError('coupon_code_taken', 409, 'Another coupon already uses this code.');
  return err;
};

// ---- offers --------------------------------------------------------------------------

exports.listOffers = catchAsync(async (req, res) => {
  const offers = await GlobalOffer.find({}).sort({ createdAt: -1, _id: -1 });
  const now = new Date();
  res.json(offers.map((o) => pricingService.offerJson(o, now)));
});

exports.getOffer = catchAsync(async (req, res) => {
  res.json(pricingService.offerJson(await loadOffer(req.params.offerId)));
});

exports.createOffer = catchAsync(async (req, res) => {
  const { target, discount, title, endsAt, enabled } = req.body;
  assertPromotion(target, discount);
  const offer = new GlobalOffer({
    enabled: !!enabled,
    target,
    discount: pricingService.discountDoc(discount),
    title: clean(title) || null,
    endsAt: endsAt || null,
    createdBy: createdBy(req.auth.account),
  });
  await withTransaction(async (session) => {
    if (offer.isLiveAt(new Date())) await assertNoOtherLiveOffer(target, offer._id, session);
    await offer.save({ session });
    await auditService.record({
      action: 'commerce_offer_created',
      actor: req.auth.account,
      target: offerTarget(offer),
      changes: [{ field: 'offer_enabled', after: offer.enabled }],
      session,
    });
  });
  res.status(201).json(pricingService.offerJson(offer));
});

exports.updateOffer = catchAsync(async (req, res) => {
  const offer = await loadOffer(req.params.offerId);
  const before = offer.enabled;
  const { target, discount, title, endsAt, enabled } = req.body;
  const nextTarget = target !== undefined ? target : offer.target;
  const nextDiscount = discount !== undefined ? discount : pricingService.discountJson(offer.discount);
  assertPromotion(nextTarget, nextDiscount);
  offer.target = nextTarget;
  if (discount !== undefined) offer.discount = pricingService.discountDoc(discount);
  if (title !== undefined) offer.title = clean(title) || null;
  if (endsAt !== undefined) offer.endsAt = endsAt || null;
  if (enabled !== undefined) offer.enabled = enabled;
  await withTransaction(async (session) => {
    if (offer.isLiveAt(new Date())) await assertNoOtherLiveOffer(offer.target, offer._id, session);
    await offer.save({ session });
    await auditService.record({
      action: 'commerce_offer_updated',
      actor: req.auth.account,
      target: offerTarget(offer),
      changes: before !== offer.enabled ? [{ field: 'offer_enabled', before, after: offer.enabled }] : [],
      session,
    });
  });
  res.json(pricingService.offerJson(offer));
});

const setOfferEnabled = (enabled) =>
  catchAsync(async (req, res) => {
    const offer = await loadOffer(req.params.offerId);
    const before = offer.enabled;
    offer.enabled = enabled;
    await withTransaction(async (session) => {
      if (enabled && offer.isLiveAt(new Date())) await assertNoOtherLiveOffer(offer.target, offer._id, session);
      if (before === enabled) return;
      await offer.save({ session });
      await auditService.record({
        action: enabled ? 'commerce_offer_enabled' : 'commerce_offer_disabled',
        actor: req.auth.account,
        target: offerTarget(offer),
        changes: [{ field: 'offer_enabled', before, after: enabled }],
        session,
      });
    });
    res.json(pricingService.offerJson(offer));
  });

exports.enableOffer = setOfferEnabled(true);
exports.disableOffer = setOfferEnabled(false);

exports.removeOffer = catchAsync(async (req, res) => {
  const offer = await loadOffer(req.params.offerId);
  await withTransaction(async (session) => {
    await GlobalOffer.deleteOne({ _id: offer._id }, { session });
    await auditService.record({ action: 'commerce_offer_removed', actor: req.auth.account, target: offerTarget(offer), session });
  });
  res.status(204).end();
});

// ---- coupons ----------------------------------------------------------------------------

exports.listCoupons = catchAsync(async (req, res) => {
  const coupons = await Coupon.find({}).sort({ createdAt: -1, _id: -1 });
  const emails = await emailsFor(coupons);
  const now = new Date();
  res.json(coupons.map((c) => pricingService.couponJson(c, emails, now)));
});

exports.getCoupon = catchAsync(async (req, res) => {
  res.json(await couponOut(await loadCoupon(req.params.couponId)));
});

exports.createCoupon = catchAsync(async (req, res) => {
  const { code: rawCode, target, discount, assignment, note, expiresAt, maxUses, enabled } = req.body;
  const code = normalizeCouponCode(rawCode);
  if (!code) throw new AppError('coupon_code_invalid', 422, 'A coupon code is 3–24 characters of A–Z, 0–9 and "-".');
  if (await Coupon.exists({ code })) throw new AppError('coupon_code_taken', 409, 'Another coupon already uses this code.');
  assertPromotion(target, discount);
  const resolved = await resolveAssignment(assignment);
  const coupon = new Coupon({
    code,
    enabled: !!enabled,
    target,
    discount: pricingService.discountDoc(discount),
    assignment: resolved,
    note: clean(note) || null,
    expiresAt: expiresAt || null,
    maxUses: maxUses === undefined ? null : maxUses,
    usedCount: 0,
    createdBy: createdBy(req.auth.account),
  });
  try {
    await withTransaction(async (session) => {
      await coupon.save({ session });
      await auditService.record({
        action: 'commerce_coupon_created',
        actor: req.auth.account,
        target: couponTarget(coupon),
        changes: [{ field: 'coupon_enabled', after: coupon.enabled }],
        session,
      });
    });
  } catch (err) {
    throw mapDuplicate(err);
  }
  res.status(201).json(await couponOut(coupon));
});

exports.updateCoupon = catchAsync(async (req, res) => {
  const coupon = await loadCoupon(req.params.couponId);
  const before = coupon.enabled;
  const { code: rawCode, target, discount, assignment, note, expiresAt, maxUses, enabled } = req.body;
  if (rawCode !== undefined) {
    const code = normalizeCouponCode(rawCode);
    if (!code) throw new AppError('coupon_code_invalid', 422, 'A coupon code is 3–24 characters of A–Z, 0–9 and "-".');
    if (code !== coupon.code && (await Coupon.exists({ code, _id: { $ne: coupon._id } }))) {
      throw new AppError('coupon_code_taken', 409, 'Another coupon already uses this code.');
    }
    coupon.code = code;
  }
  const nextTarget = target !== undefined ? target : coupon.target;
  const nextDiscount = discount !== undefined ? discount : pricingService.discountJson(coupon.discount);
  assertPromotion(nextTarget, nextDiscount);
  coupon.target = nextTarget;
  if (discount !== undefined) coupon.discount = pricingService.discountDoc(discount);
  if (assignment !== undefined) coupon.assignment = await resolveAssignment(assignment);
  if (note !== undefined) coupon.note = clean(note) || null;
  if (expiresAt !== undefined) coupon.expiresAt = expiresAt || null;
  if (maxUses !== undefined) coupon.maxUses = maxUses;
  if (enabled !== undefined) coupon.enabled = enabled;
  try {
    await withTransaction(async (session) => {
      await coupon.save({ session });
      await auditService.record({
        action: 'commerce_coupon_updated',
        actor: req.auth.account,
        target: couponTarget(coupon),
        changes: before !== coupon.enabled ? [{ field: 'coupon_enabled', before, after: coupon.enabled }] : [],
        session,
      });
    });
  } catch (err) {
    throw mapDuplicate(err);
  }
  res.json(await couponOut(coupon));
});

const setCouponEnabled = (enabled) =>
  catchAsync(async (req, res) => {
    const coupon = await loadCoupon(req.params.couponId);
    const before = coupon.enabled;
    if (before !== enabled) {
      coupon.enabled = enabled;
      await withTransaction(async (session) => {
        await coupon.save({ session });
        await auditService.record({
          action: enabled ? 'commerce_coupon_enabled' : 'commerce_coupon_disabled',
          actor: req.auth.account,
          target: couponTarget(coupon),
          changes: [{ field: 'coupon_enabled', before, after: enabled }],
          session,
        });
      });
    }
    res.json(await couponOut(coupon));
  });

exports.enableCoupon = setCouponEnabled(true);
exports.disableCoupon = setCouponEnabled(false);

exports.removeCoupon = catchAsync(async (req, res) => {
  const coupon = await loadCoupon(req.params.couponId);
  await withTransaction(async (session) => {
    await Coupon.deleteOne({ _id: coupon._id }, { session });
    await auditService.record({ action: 'commerce_coupon_removed', actor: req.auth.account, target: couponTarget(coupon), session });
  });
  res.status(204).end();
});
