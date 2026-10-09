/**
 * The account's devices (/more/security/devices) and a trusted device's answer
 * to "a new device signed in" (services/deviceService).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const deviceService = require('../../services/deviceService');

// GET /auth/devices → { limit, devices: [Device] }
exports.list = catchAsync(async (req, res) => {
  res.status(200).json(await deviceService.list(req.auth.account, req.auth.session));
});

// POST /auth/devices/:deviceId/approve → 204  ("Yes, this is my device")
exports.approve = catchAsync(async (req, res) => {
  await deviceService.approve(req, req.params.deviceId);
  res.status(204).end();
});

// POST /auth/devices/:deviceId/deny → 200 { passwordReset }  ("No, this is not me")
exports.deny = catchAsync(async (req, res) => {
  res.status(200).json(await deviceService.deny(req, req.params.deviceId));
});

// DELETE /auth/devices/:deviceId → 204
exports.remove = catchAsync(async (req, res) => {
  await deviceService.remove(req, req.params.deviceId);
  res.status(204).end();
});
