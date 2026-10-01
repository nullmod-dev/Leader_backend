/** GET /platform/reports/* — the four Point 13 report projections. */
const catchAsync = require('../../utils/catchAsyncErrors');
const reports = require('../../services/reportService');

exports.subscriptions = catchAsync(async (req, res) => {
  res.json(await reports.subscriptions(req.query));
});

exports.usageLimits = catchAsync(async (req, res) => {
  res.json(await reports.usageLimits(req.query));
});

exports.featureAvailability = catchAsync(async (req, res) => {
  res.json(await reports.featureAvailability(req.query));
});

exports.platformActivity = catchAsync(async (req, res) => {
  res.json(await reports.platformActivity(req.query, new Date()));
});
