/**
 * /auth/customer-demo — the self-service trial.
 * Flutter: the post-verification «تجربة ليدر» option, DemoTrialBar, /demo-expired.
 */
const catchAsync = require('../utils/catchAsyncErrors');
const demoService = require('../services/demoService');

/** POST /start — public. 201 new trial · 200 resumed trial. */
exports.start = catchAsync(async (req, res) => {
  const { status, body } = await demoService.start(req, req.body || {});
  res.status(status).json(body);
});

/** GET /session → { demoSession, serverNow } */
exports.session = catchAsync(async (req, res) => {
  res.json(await demoService.current(req.auth.account));
});

/** POST /end → { demoSession } (terminated, user_ended) */
exports.end = catchAsync(async (req, res) => {
  res.json(await demoService.endOwn(req.auth.account));
});
