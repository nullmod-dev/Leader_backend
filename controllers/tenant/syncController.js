/**
 * /sync — outbox push, change-feed pull, status. See services/syncService.js
 * and docs/api/sync.md.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const syncService = require('../../services/syncService');

exports.push = catchAsync(async (req, res) => {
  res.json(await syncService.push(req, req.body.operations));
});

exports.pull = catchAsync(async (req, res) => {
  res.json(await syncService.pull({ tenant: req.tenant, grant: req.grant, tz: req.tz }, req.query || {}));
});

exports.status = catchAsync(async (req, res) => {
  res.json(await syncService.status(req.tenantId));
});
