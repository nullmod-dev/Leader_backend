/**
 * /platform/tenants/:tenantId/lifecycle/** — the five Point 9 commands
 * (screen: tenant detail → operations). The state machine and the final
 * deletion cascade live in services/tenantLifecycleService.js.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const lifecycleService = require('../../services/tenantLifecycleService');

const command = (name) =>
  catchAsync(async (req, res) => {
    const result = await lifecycleService.runCommand(name, req.params.tenantId, req.body, req.auth.account);
    res.json(result);
  });

exports.suspend = command('suspend');
exports.reactivate = command('reactivate');
exports.beginDeletion = command('beginDeletion');
exports.cancelDeletion = command('cancelDeletion');
exports.finalizeDeletion = command('finalizeDeletion');
