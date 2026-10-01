/**
 * /tenant/analytics/** — see services/tenantAnalyticsService.js and
 * docs/api/tenant-analytics.md for every metric definition.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const analytics = require('../../services/tenantAnalyticsService');

const ctx = (req) => ({ tenant: req.tenant, grant: req.grant, tz: req.tz, query: req.query || {} });

exports.dashboard = catchAsync(async (req, res) => {
  res.json(await analytics.dashboard(ctx(req)));
});

exports.detachment = catchAsync(async (req, res) => {
  res.json(await analytics.detachmentReport({ ...ctx(req), detachment: req.docs.detachment }));
});

exports.workshops = catchAsync(async (req, res) => {
  res.json(await analytics.workshopsReport(ctx(req)));
});

exports.inventory = catchAsync(async (req, res) => {
  res.json(await analytics.inventoryReport(ctx(req)));
});
