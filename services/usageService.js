/**
 * Plan limits and usage (Point 7).
 *
 *   effective[key] = tenant.subscription.limitOverrides[key] ?? plan.defaultLimits[key]
 *
 * No plan → every limit is null (`no_limit`). A limit BELOW usage is allowed:
 * nothing is deleted, future creates of that resource are refused with
 * `plan_limit_reached` until usage drops.
 *
 * Usage counts (platform aggregates, computed server-side):
 *   detachment_groups — every group
 *   detachments       — non-archived detachments
 *   admins            — tenant accounts (main_admin + admin) not revoked
 *   members           — active team members
 *   workshops         — non-archived workshops
 *   storage_bytes     — bytes of uploaded files (tenant.usage.storageUsedBytes)
 */
const mongoose = require('mongoose');
const { PLAN_LIMIT_KEYS } = require('../config/constants');
const AppError = require('../utils/appError');

const models = () => require('../models');

const computeUsage = async (tenant) => {
  const { DetachmentGroup, Detachment, Account, TeamMember, Workshop } = models();
  const tenantId = String(tenant._id);
  const [groups, detachments, admins, members, workshops] = await Promise.all([
    DetachmentGroup.countDocuments({ tenantId }),
    Detachment.countDocuments({ tenantId, status: { $ne: 'archived' } }),
    Account.countDocuments({ saasTenantId: tenantId, role: { $in: ['main_admin', 'admin'] }, status: { $ne: 'revoked' } }),
    TeamMember.countDocuments({ tenantId, active: true }),
    Workshop.countDocuments({ tenantId, archived: { $ne: true } }),
  ]);
  return {
    detachment_groups: groups,
    detachments,
    admins,
    members,
    workshops,
    storage_bytes: tenant.usage?.storageUsedBytes || 0,
  };
};

const overridesOf = (tenant) => {
  const o = tenant.subscription?.limitOverrides;
  if (!o) return {};
  return o instanceof Map ? Object.fromEntries(o) : { ...o };
};

/** { key: effective|null } for every known key (null = no plan = no limit). */
const effectiveLimits = (tenant, plan) => {
  const overrides = overridesOf(tenant);
  const out = {};
  PLAN_LIMIT_KEYS.forEach((k) => {
    if (!plan) out[k] = null;
    else out[k] = overrides[k] !== undefined && overrides[k] !== null ? overrides[k] : plan.defaultLimits[k];
  });
  return out;
};

const loadPlan = async (tenant) => {
  const { Plan } = models();
  if (!tenant.subscription?.planId) return null;
  return Plan.findById(tenant.subscription.planId);
};

/** Limits projection rows: [{ key, planDefault, effective, overridden, usage }]. */
const limitRows = async (tenant, { includeUsage = true } = {}) => {
  const plan = await loadPlan(tenant);
  const usage = includeUsage ? await computeUsage(tenant) : null;
  const overrides = overridesOf(tenant);
  const effective = effectiveLimits(tenant, plan);
  return {
    plan,
    usage,
    rows: PLAN_LIMIT_KEYS.map((key) => {
      const row = { key, overridden: overrides[key] !== undefined && overrides[key] !== null };
      if (plan) {
        row.planDefault = plan.defaultLimits[key];
        row.effective = effective[key];
      }
      if (usage) row.usage = usage[key];
      return row;
    }),
  };
};

/**
 * Refuse a create that would exceed the effective limit.
 * @param tenant SaasTenant doc
 * @param key    PLAN_LIMIT_KEYS member
 * @param amount how much the operation consumes (1 by default; bytes for storage)
 */
const assertCanConsume = async (tenant, key, amount = 1) => {
  const plan = await loadPlan(tenant);
  if (!plan) return;
  const limit = effectiveLimits(tenant, plan)[key];
  if (limit === null || limit === undefined) return;
  const usage = (await computeUsage(tenant))[key];
  if (usage + amount > limit) {
    throw new AppError('plan_limit_reached', 409, `The plan limit for ${key} is reached.`, { limitKey: key, limit, usage });
  }
};

/** Keep `lastActivityAt` fresh without a write on every request (≤ once / 5 min). */
const touchActivity = async (tenant) => {
  const last = tenant.usage?.lastActivityAt;
  if (last && Date.now() - new Date(last).getTime() < 5 * 60000) return;
  await mongoose.connection
    .collection('saas_tenants')
    .updateOne({ _id: tenant._id }, { $set: { 'usage.lastActivityAt': new Date() } });
};

module.exports = { computeUsage, effectiveLimits, limitRows, assertCanConsume, loadPlan, overridesOf, touchActivity };
