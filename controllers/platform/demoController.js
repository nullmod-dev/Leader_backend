/**
 * /platform/demo — Customer Demo policy and operational sessions.
 * Flutter: /platform/operations/demo («إدارة الحسابات التجريبية»).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const demoService = require('../../services/demoService');

exports.getPolicy = catchAsync(async (req, res) => {
  res.json(await demoService.getPolicy());
});

exports.patchPolicy = catchAsync(async (req, res) => {
  res.json(await demoService.updatePolicy(req.body, req.auth.account));
});

exports.listSessions = catchAsync(async (req, res) => {
  res.json(await demoService.listSessions(req.query));
});

exports.terminate = catchAsync(async (req, res) => {
  res.json(await demoService.terminate(req.params.demoSessionId, req.auth.account));
});

exports.terminateAll = catchAsync(async (req, res) => {
  res.json(await demoService.terminateAll(req.auth.account));
});

exports.cleanup = catchAsync(async (req, res) => {
  res.json(await demoService.cleanup());
});
