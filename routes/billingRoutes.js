/**
 * /api/v1/billing — tenant checkout and orders (docs/api/commerce.md).
 * Main Admin only; the ONLY commercial write a tenant session can make.
 */
const express = require('express');
const { tenantGuard } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const v = require('../validators/commerceValidators');
const ctrl = require('../controllers/billingController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard, ctrl.requireMainAdmin);

router.post('/checkout', validate(v.checkout), idempotent({ required: true }), ctrl.checkout);
router.get('/orders', ctrl.listOrders);
router.get('/orders/:orderId', ctrl.getOrder);

module.exports = router;
