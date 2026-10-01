/**
 * /platform/admins — Super Admin accounts (screen: platform settings →
 * administrators). A Super Admin holds no capability key and no tenant.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account } = require('../../models');
const { iso } = require('../../utils/time');
const auditService = require('../../services/auditService');
const tokenService = require('../../services/tokenService');

const serializeAdmin = (a) => ({
  id: String(a._id),
  name: a.name || '',
  email: a.email || '',
  status: a.status,
  mfaEnabled: !!(a.mfa && a.mfa.enabled),
  lastLoginAt: iso(a.lastLoginAt),
  createdAt: iso(a.createdAt),
});

const target = (a) => ({ type: 'platform_admin', id: String(a._id), displayName: a.name || '' });

const loadAdmin = async (accountId) => {
  const account = await Account.findOne({ _id: accountId, role: 'super_admin' });
  if (!account) throw AppError.notFound('platform admin');
  return account;
};

/** GET /platform/admins */
exports.list = catchAsync(async (req, res) => {
  const admins = await Account.find({ role: 'super_admin' }).sort({ createdAt: 1, _id: 1 });
  res.json(admins.map(serializeAdmin));
});

/** POST /platform/admins { name, email, password } */
exports.create = catchAsync(async (req, res) => {
  const { name, email, password } = req.body;
  const inUse = () => AppError.conflict('This email already belongs to an account.', { fields: { email: 'This email is already in use.' } });
  if (await Account.exists({ email })) throw inUse();
  const account = new Account({
    email,
    name,
    role: 'super_admin',
    saasTenantId: null,
    emailVerified: true,
    setupCompleted: true,
    status: 'active',
    linkStatus: 'unlinked',
    activatedAt: new Date(),
  });
  await account.setPassword(password);
  try {
    await account.save();
  } catch (err) {
    if (err && err.code === 11000) throw inUse();
    throw err;
  }
  await auditService.record({
    action: 'platform_admin_created',
    actor: req.auth.account,
    target: target(account),
    changes: [{ field: 'account_status', after: 'active' }],
  });
  res.status(201).json(serializeAdmin(account));
});

/** POST /platform/admins/:accountId/suspend { reason } — ends every session of the account. */
exports.suspend = catchAsync(async (req, res) => {
  const account = await loadAdmin(req.params.accountId);
  if (String(account._id) === String(req.auth.account._id)) throw AppError.conflict('You cannot suspend your own account.');
  if (account.status !== 'active') throw AppError.conflict('Only an active administrator can be suspended.', { accountStatus: account.status });
  account.status = 'suspended';
  account.suspension = { suspendedAt: new Date(), reason: req.body.reason };
  await account.save();
  await tokenService.revokeAllForAccount(account._id, 'account_suspended');
  await auditService.record({
    action: 'platform_admin_suspended',
    actor: req.auth.account,
    target: target(account),
    changes: [{ field: 'account_status', before: 'active', after: 'suspended' }],
  });
  res.json(serializeAdmin(account));
});

/** POST /platform/admins/:accountId/reactivate */
exports.reactivate = catchAsync(async (req, res) => {
  const account = await loadAdmin(req.params.accountId);
  if (account.status !== 'suspended') throw AppError.conflict('Only a suspended administrator can be reactivated.', { accountStatus: account.status });
  account.status = 'active';
  account.suspension = undefined;
  await account.save();
  await auditService.record({
    action: 'platform_admin_reactivated',
    actor: req.auth.account,
    target: target(account),
    changes: [{ field: 'account_status', before: 'suspended', after: 'active' }],
  });
  res.json(serializeAdmin(account));
});
