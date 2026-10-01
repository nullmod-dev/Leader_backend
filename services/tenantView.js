/**
 * The control-plane `SaasTenant` representation (API_CONTRACT.md → "SaasTenant —
 * the subscriber resource") and the small projections the platform tenant
 * screens read: lifecycle, subscription, feature rows, status-history rows.
 *
 * Counts are PLATFORM AGGREGATES computed here from the tenant collections —
 * the control plane never asks a tenant-operational endpoint for them:
 *   detachmentGroups — every group
 *   detachments      — non-archived detachments
 *   members          — active team members
 *   workshops        — non-archived workshops
 */
const { Account, DetachmentGroup, Detachment, TeamMember, Workshop } = require('../models');
const { iso } = require('../utils/time');
const { overridesOf } = require('./usageService');

const EMPTY_COUNTS = Object.freeze({ detachmentGroups: 0, detachments: 0, members: 0, workshops: 0 });

/** Counts for ONE tenant. */
const countsOf = async (tenantId) => {
  const id = String(tenantId);
  const [detachmentGroups, detachments, members, workshops] = await Promise.all([
    DetachmentGroup.countDocuments({ tenantId: id }),
    Detachment.countDocuments({ tenantId: id, status: { $ne: 'archived' } }),
    TeamMember.countDocuments({ tenantId: id, active: true }),
    Workshop.countDocuments({ tenantId: id, archived: { $ne: true } }),
  ]);
  return { detachmentGroups, detachments, members, workshops };
};

const groupCount = async (Model, match) => {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

/** Counts for MANY tenants in four aggregations → Map<tenantId, counts>. */
const countsFor = async (tenantIds) => {
  const ids = tenantIds.map(String);
  const out = new Map(ids.map((id) => [id, { ...EMPTY_COUNTS }]));
  if (!ids.length) return out;
  const [groups, dets, members, workshops] = await Promise.all([
    groupCount(DetachmentGroup, { tenantId: { $in: ids } }),
    groupCount(Detachment, { tenantId: { $in: ids }, status: { $ne: 'archived' } }),
    groupCount(TeamMember, { tenantId: { $in: ids }, active: true }),
    groupCount(Workshop, { tenantId: { $in: ids }, archived: { $ne: true } }),
  ]);
  ids.forEach((id) => {
    out.set(id, {
      detachmentGroups: groups.get(id) || 0,
      detachments: dets.get(id) || 0,
      members: members.get(id) || 0,
      workshops: workshops.get(id) || 0,
    });
  });
  return out;
};

/** The seat holder of every tenant, loaded in one query → Map<accountId, Account>. */
const mainAdminsFor = async (tenants) => {
  const ids = [...new Set(tenants.map((t) => t.seat && t.seat.currentAccountId).filter(Boolean))];
  if (!ids.length) return new Map();
  const accounts = await Account.find({ _id: { $in: ids } });
  return new Map(accounts.map((a) => [String(a._id), a]));
};

const mainAdminOf = async (tenant, { session } = {}) =>
  tenant.seat && tenant.seat.currentAccountId
    ? Account.findById(tenant.seat.currentAccountId).session(session || null)
    : null;

// ---- projections ------------------------------------------------------------------

const has = (obj, key) => !!(obj && obj[key] !== undefined && obj[key] !== null);

/** { status, version, suspension?, deletion? } */
const serializeLifecycle = (tenant, { deletedAt } = {}) => {
  const l = tenant.lifecycle || {};
  const out = { status: l.status, version: l.version };
  if (has(l.suspension, 'suspendedAt')) {
    out.suspension = { suspendedAt: iso(l.suspension.suspendedAt), reason: l.suspension.reason || '' };
  }
  if (has(l.deletion, 'requestedAt')) {
    out.deletion = {
      requestedAt: iso(l.deletion.requestedAt),
      scheduledFor: iso(l.deletion.scheduledFor),
      previousStatus: l.deletion.previousStatus,
      reason: l.deletion.reason || '',
    };
    if (deletedAt) out.deletion.deletedAt = iso(deletedAt);
  }
  return out;
};

/** { status, planId, version, trialEndsAt, renewsAt, graceEndsAt, limitOverrides } */
const serializeSubscription = (tenant) => {
  const s = tenant.subscription || {};
  return {
    status: s.status,
    planId: s.planId || null,
    version: s.version,
    trialEndsAt: iso(s.trialEndsAt),
    renewsAt: iso(s.renewsAt),
    graceEndsAt: iso(s.graceEndsAt),
    limitOverrides: overridesOf(tenant),
  };
};

const serializeFeature = (row) => ({
  key: row.key,
  enabled: row.enabled === true,
  version: row.version,
  updatedAt: iso(row.updatedAt),
});

const serializeMainAdmin = (account) => {
  // A seat is never empty for tenants created through the API. Data inserted
  // outside it still yields a readable record rather than a broken list.
  if (!account) return { name: '', email: '', provisioning: 'pending_setup' };
  return {
    name: account.name || '',
    email: account.email || '',
    provisioning: account.status === 'pending_setup' ? 'pending_setup' : 'active',
  };
};

const serializeUsage = (tenant) => {
  const u = tenant.usage || {};
  const out = { storageUsedBytes: u.storageUsedBytes || 0 };
  if (u.storageAllowanceBytes !== undefined && u.storageAllowanceBytes !== null) out.storageAllowanceBytes = u.storageAllowanceBytes;
  out.lastActivityAt = iso(u.lastActivityAt);
  return out;
};

/**
 * The SaasTenant wire object.
 * @param tenant            SaasTenant doc
 * @param opts.mainAdminAccount  the seat's current Account (or null)
 * @param opts.counts       platform aggregates (see countsOf)
 */
const serializeTenant = (tenant, { mainAdminAccount = null, counts = EMPTY_COUNTS } = {}) => ({
  id: String(tenant._id),
  displayName: tenant.displayName,
  teamCode: tenant.teamCode,
  timezone: tenant.timezone,
  lifecycle: serializeLifecycle(tenant),
  createdAt: iso(tenant.createdAt),
  updatedAt: iso(tenant.updatedAt),
  mainAdmin: serializeMainAdmin(mainAdminAccount),
  subscription: serializeSubscription(tenant),
  usage: serializeUsage(tenant),
  counts: { ...EMPTY_COUNTS, ...counts },
});

/** Load the seat holder + counts and serialize one tenant. */
const tenantPayload = async (tenant) => {
  const [account, counts] = await Promise.all([mainAdminOf(tenant), countsOf(tenant._id)]);
  return serializeTenant(tenant, { mainAdminAccount: account, counts });
};

const serializeStatusEvent = (evt) => ({
  id: String(evt._id),
  type: evt.type,
  occurredAt: iso(evt.occurredAt),
  note: evt.note === undefined ? null : evt.note,
});

module.exports = {
  EMPTY_COUNTS,
  countsOf,
  countsFor,
  mainAdminsFor,
  mainAdminOf,
  serializeLifecycle,
  serializeSubscription,
  serializeFeature,
  serializeMainAdmin,
  serializeUsage,
  serializeTenant,
  tenantPayload,
  serializeStatusEvent,
};
