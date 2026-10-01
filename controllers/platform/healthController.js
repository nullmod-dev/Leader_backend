/** GET /platform/health — the three product-level health signals. */
const catchAsync = require('../../utils/catchAsyncErrors');
const insights = require('../../services/platformInsightsService');

exports.health = catchAsync(async (req, res) => {
  res.json(await insights.health(new Date()));
});
