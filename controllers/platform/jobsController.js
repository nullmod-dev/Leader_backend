/** /platform/jobs — background-job heartbeat list and manual runs. */
const catchAsync = require('../../utils/catchAsyncErrors');
const insights = require('../../services/platformInsightsService');

exports.list = catchAsync(async (req, res) => {
  res.json(await insights.listJobs());
});

exports.runAll = catchAsync(async (req, res) => {
  res.json(await insights.runAllJobs());
});

exports.runOne = catchAsync(async (req, res) => {
  res.json(await insights.runOneJob(req.params.name));
});
