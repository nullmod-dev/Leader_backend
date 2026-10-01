/**
 * /tenant/simple-admins and /tenant/simple-admin-invitations — Simple Admin
 * management (Flutter SimpleAdminRepository). Rules live in
 * services/simpleAdminService.js.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const simpleAdminService = require('../../services/simpleAdminService');

exports.list = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.snapshot(req.tenant));
});

exports.invite = catchAsync(async (req, res) => {
  res.status(201).json(await simpleAdminService.invite(req.tenant, req.auth.account, req.body));
});

exports.cancelInvitation = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.cancelInvitation(req.tenant, req.auth.account, req.params.invitationId, req.body));
});

exports.resendInvitation = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.resendInvitation(req.tenant, req.auth.account, req.params.invitationId));
});

exports.updateCapabilities = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.updateCapabilities(req.tenant, req.auth.account, req.params.accountId, req.body));
});

exports.suspend = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.suspend(req.tenant, req.auth.account, req.params.accountId, req.body));
});

exports.reactivate = catchAsync(async (req, res) => {
  res.json(await simpleAdminService.reactivate(req.tenant, req.auth.account, req.params.accountId));
});
