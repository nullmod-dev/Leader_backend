/** GET /platform/overview — the Super Admin decision-first overview. */
const catchAsync = require('../../utils/catchAsyncErrors');
const insights = require('../../services/platformInsightsService');

exports.overview = catchAsync(async (req, res) => {
  res.json(await insights.overview(new Date()));
});
