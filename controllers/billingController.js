/**
 * /billing — tenant checkout (Point 19). Main Admin only.
 * Flutter: /more/pricing → «اشترك» (manual payment through Leader support).
 */
const catchAsync = require('../utils/catchAsyncErrors');
const AppError = require('../utils/appError');
const billingService = require('../services/billingService');

/** Money is the Main Admin's: a Simple Admin is refused. */
exports.requireMainAdmin = (req, res, next) => {
  if (req.auth.account.role !== 'main_admin') return next(AppError.notPermitted('Only the Main Admin can manage the subscription.'));
  return next();
};

/** POST /checkout (Idempotency-Key) → 201 { order, payment } */
exports.checkout = catchAsync(async (req, res) => {
  const result = await billingService.checkout({
    tenant: req.tenant,
    account: req.auth.account,
    billingOptionId: req.body.billingOptionId,
    couponCode: req.body.couponCode,
  });
  res.status(201).json(result);
});

/** GET /orders → [Order] newest first */
exports.listOrders = catchAsync(async (req, res) => {
  res.json(await billingService.tenantOrders(req.tenantId));
});

/** GET /orders/:orderId → Order */
exports.getOrder = catchAsync(async (req, res) => {
  res.json(await billingService.tenantOrder(req.tenantId, req.params.orderId));
});
