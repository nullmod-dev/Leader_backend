/** GET /platform/audit (+ /:eventId) — the platform audit stream, read-only. */
const catchAsync = require('../../utils/catchAsyncErrors');
const insights = require('../../services/platformInsightsService');

exports.list = catchAsync(async (req, res) => {
  res.json(await insights.listAudit(req.query));
});

exports.get = catchAsync(async (req, res) => {
  res.json(await insights.getAuditEvent(req.params.eventId));
});
