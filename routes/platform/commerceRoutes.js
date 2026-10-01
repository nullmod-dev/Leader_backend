/**
 * /api/v1/platform/commerce — global offers and coupons (docs/api/commerce.md).
 * Super Admin only.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/commerceValidators');
const ctrl = require('../../controllers/platform/commerceController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/offers', ctrl.listOffers);
router.post('/offers', validate(v.offerCreate), idempotent({ required: true }), ctrl.createOffer);
router.get('/offers/:offerId', ctrl.getOffer);
router.patch('/offers/:offerId', validate(v.offerPatch), idempotent(), ctrl.updateOffer);
router.post('/offers/:offerId/enable', idempotent(), ctrl.enableOffer);
router.post('/offers/:offerId/disable', idempotent(), ctrl.disableOffer);
router.delete('/offers/:offerId', idempotent(), ctrl.removeOffer);

router.get('/coupons', ctrl.listCoupons);
router.post('/coupons', validate(v.couponCreate), idempotent({ required: true }), ctrl.createCoupon);
router.get('/coupons/:couponId', ctrl.getCoupon);
router.patch('/coupons/:couponId', validate(v.couponPatch), idempotent(), ctrl.updateCoupon);
router.post('/coupons/:couponId/enable', idempotent(), ctrl.enableCoupon);
router.post('/coupons/:couponId/disable', idempotent(), ctrl.disableCoupon);
router.delete('/coupons/:couponId', idempotent(), ctrl.removeCoupon);

module.exports = router;
