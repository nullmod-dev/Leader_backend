/** GET /platform/analytics/* — Super Admin dashboard charts and KPI tiles. */
const catchAsync = require('../../utils/catchAsyncErrors');
const analytics = require('../../services/platformAnalyticsService');

exports.summary = catchAsync(async (req, res) => {
  res.json(await analytics.summary(req.query, new Date()));
});

exports.growth = catchAsync(async (req, res) => {
  res.json(await analytics.growth(req.query, new Date()));
});

exports.tenants = catchAsync(async (req, res) => {
  res.json(await analytics.tenants(req.query));
});

exports.tenant = catchAsync(async (req, res) => {
  res.json(await analytics.tenant(req.params.tenantId, req.query, new Date()));
});
