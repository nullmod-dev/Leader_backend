/**
 * /platform/accounts — cross-tenant account lookup for support and coupon
 * targeting (screen: platform operations → accounts). Read-only apart from
 * "sign out everywhere". Never returns credentials, MFA material or sessions.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const cursor = require('../../utils/cursor');
const { escapeRegex } = require('../../utils/normalize');
const { iso } = require('../../utils/time');
const { Account, SaasTenant, Session } = require('../../models');
const auditService = require('../../services/auditService');
const tokenService = require('../../services/tokenService');

const serializeAccount = (a, tenantNames) => ({
  id: String(a._id),
  name: a.name || '',
  email: a.email || '',
  role: a.role || null,
  status: a.status,
  saasTenantId: a.saasTenantId || null,
  tenantName: (a.saasTenantId && tenantNames.get(a.saasTenantId)) || null,
  emailVerified: !!a.emailVerified,
  methods: [...(a.methods || [])],
  lastLoginAt: iso(a.lastLoginAt),
  createdAt: iso(a.createdAt),
});

const tenantNamesFor = async (accounts) => {
  const ids = [...new Set(accounts.map((a) => a.saasTenantId).filter(Boolean))];
  if (!ids.length) return new Map();
  const tenants = await SaasTenant.find({ _id: { $in: ids } }, { displayName: 1 });
  return new Map(tenants.map((t) => [String(t._id), t.displayName]));
};

/** GET /platform/accounts?search&role&tenantId&status&cursor&limit — newest first. */
exports.list = catchAsync(async (req, res) => {
  const { search, role, tenantId, status, limit } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (tenantId) filter.saasTenantId = tenantId;
  if (status) filter.status = status;
  const and = [];
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    and.push({ $or: [{ name: re }, { email: re }] });
  }
  const position = cursor.decode(req.query.cursor);
  if (position) {
    const at = new Date(position.c);
    if (Number.isNaN(at.getTime()) || typeof position.i !== 'string') {
      throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
    }
    and.push({ $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: position.i } }] });
  }
  if (and.length) filter.$and = and;

  const rows = await Account.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const names = await tenantNamesFor(page);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? cursor.encode({ c: last.createdAt.toISOString(), i: String(last._id) }) : null;
  res.json({ items: page.map((a) => serializeAccount(a, names)), nextCursor });
});

const loadAccount = async (accountId) => {
  const account = await Account.findById(accountId);
  if (!account) throw AppError.notFound('account');
  return account;
};

/** GET /platform/accounts/:accountId — + the number of live sessions. */
exports.get = catchAsync(async (req, res) => {
  const account = await loadAccount(req.params.accountId);
  const names = await tenantNamesFor([account]);
  const activeSessions = await Session.countDocuments({
    accountId: String(account._id),
    revokedAt: { $exists: false },
    refreshExpiresAt: { $gt: new Date() },
  });
  res.json({ ...serializeAccount(account, names), activeSessions });
});

/** POST /platform/accounts/:accountId/sign-out-all → { revoked } */
exports.signOutAll = catchAsync(async (req, res) => {
  const account = await loadAccount(req.params.accountId);
  const revoked = await tokenService.revokeAllForAccount(account._id, 'signed_out_by_platform');
  await auditService.record({
    action: 'account_sessions_revoked',
    actor: req.auth.account,
    target: { type: 'account', id: String(account._id), displayName: account.name },
    tenant: account.saasTenantId ? { id: account.saasTenantId, displayName: '' } : undefined,
  });
  res.json({ revoked });
});
