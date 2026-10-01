/**
 * /api/v1/pricing — catalogue, live offers, quotes, coupon validation
 * (docs/api/commerce.md). Reads are public; quote/validate need any full
 * session (tenant, platform or an ACTIVE Customer Demo). Nothing here writes.
 */
const express = require('express');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsyncErrors');
const { protect, requireMfa, requireActiveAccount, optionalAuth } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const demoService = require('../services/demoService');
const v = require('../validators/commerceValidators');
const ctrl = require('../controllers/pricingController');

const router = express.Router({ mergeParams: true });

/** A demo whose window closed (server time) is no longer authorized to call anything. */
const activeDemoOnly = catchAsync(async (req, res, next) => {
  const { account } = req.auth;
  if (account.role === 'customer_demo' && !(await demoService.isActiveDemo(account))) {
    throw new AppError('authentication_expired', 401, 'The demo session has ended.');
  }
  next();
});

const sessionGuard = [protect, requireMfa, requireActiveAccount, activeDemoOnly];

router.get('/catalog', ctrl.catalog);
router.get('/offers/active', ctrl.activeOffers);
router.get('/quotes', optionalAuth, ctrl.quotes);
router.post('/quote', sessionGuard, validate(v.quote), ctrl.quote);
router.post('/coupons/validate', sessionGuard, validate(v.validateCoupon), ctrl.validateCoupon);

module.exports = router;
