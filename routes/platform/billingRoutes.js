/**
 * /api/v1/platform/billing — manual payment confirmation (docs/api/commerce.md).
 * Super Admin only.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/commerceValidators');
const ctrl = require('../../controllers/platform/billingAdminController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/orders', validate(v.ordersQuery, 'query'), ctrl.listOrders);
router.get('/orders/:orderId', ctrl.getOrder);
router.post('/orders/:orderId/confirm', validate(v.confirm), idempotent({ required: true }), ctrl.confirm);
router.post('/orders/:orderId/cancel', idempotent({ required: true }), ctrl.cancel);

module.exports = router;
