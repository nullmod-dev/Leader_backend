/**
 * /platform/billing — manual payment confirmation (Point 19).
 * Flutter: /platform/operations/commerce (orders).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const billingService = require('../../services/billingService');

exports.listOrders = catchAsync(async (req, res) => {
  res.json(await billingService.listOrders(req.query));
});

exports.getOrder = catchAsync(async (req, res) => {
  res.json(await billingService.platformOrder(req.params.orderId));
});

/** POST /orders/:orderId/confirm (Idempotency-Key) → { order, subscription } */
exports.confirm = catchAsync(async (req, res) => {
  res.json(
    await billingService.confirmOrder({
      orderId: req.params.orderId,
      actor: req.auth.account,
      paymentReference: req.body.paymentReference || null,
    }),
  );
});

/** POST /orders/:orderId/cancel (Idempotency-Key) → Order */
exports.cancel = catchAsync(async (req, res) => {
  res.json(await billingService.cancelOrder({ orderId: req.params.orderId, actor: req.auth.account }));
});
