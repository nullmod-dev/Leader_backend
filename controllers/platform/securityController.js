/** GET /platform/security-alerts — computed 24 h security-awareness snapshot. */
const catchAsync = require('../../utils/catchAsyncErrors');
const insights = require('../../services/platformInsightsService');

exports.securityAlerts = catchAsync(async (req, res) => {
  res.json(await insights.securityAlertsSnapshot(new Date()));
});
