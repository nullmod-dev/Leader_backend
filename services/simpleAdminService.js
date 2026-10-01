/**
 * Simple Admin management (Point 18B) — the tenant side of the
 * `simple_admin` Authorization and of role `admin` accounts.
 *
 * Concurrency: every mutation of the management snapshot bumps
 * `SaasTenant.adminManagementRevision`. Commands that carry
 * `expectedRevision` bump it CONDITIONALLY (compare-and-set inside the
 * transaction), so two admins acting on the same snapshot can never both win:
 * the loser gets `409 stale_admin_management`.
 *
 * Tenant and role are ALWAYS derived by the server (the caller's tenant,
 * role `admin`); the request body can set neither.
 */
const { Account, Authorization, SaasTenant, Detachment } = require('../models');
const AppError = require('../utils/appError');
const caps = require('../config/capabilities');
const { collapse, email: normEmail, isEmail } = require('../utils/normalize');
const { iso } = require('../utils/time');
const { withTransaction } = require('./txn');
const auditService = require('./auditService');
const emailService = require('./emailService');
const usageService = require('./usageService');
const tokenService = require('./tokenService');
const authorizationService = require('./authorizationService');

// ---- JSON -------------------------------------------------------------------------

const grantJson = (grant) => caps.normalizeGrant(grant);

/** Flat, sorted key list of a grant (audit `capability_grant`). */
const grantKeys = (grant) => {
  const g = caps.normalizeGrant(grant);
  return [...new Set([...g.global, ...Object.values(g.scoped).flat()])].sort();
};

const invitationJson = (az, now = new Date()) => ({
  id: String(az._id),
  tenantId: az.tenantId,
  email: az.email,
  suggestedName: az.suggestedName || '',
  status: az.effectiveStatus(now),
  capabilities: grantJson(az.capabilities),
  createdAt: iso(az.createdAt),
  expiresAt: az.expiresAt ? iso(az.expiresAt) : null,
});

const accountJson = (a) => ({
  id: String(a._id),
  tenantId: a.saasTenantId,
  email: a.email || '',
  name: a.name || '',
  status: a.status,
  capabilities: grantJson(a.capabilities),
  createdAt: iso(a.createdAt),
  lastLoginAt: a.lastLoginAt ? iso(a.lastLoginAt) : null,
});

// ---- rules ----------------------------------------------------------------------------

/** SIMPLE_ADMIN_ASSIGNABLE keys whose module is enabled for this tenant. */
const assignableKeys = (tenant) =>
  caps.SIMPLE_ADMIN_ASSIGNABLE.filter((k) => !caps.CAP_FEATURE[k] || tenant.featureEnabled(caps.CAP_FEATURE[k]));

/** Every key assignable + module on; every detachment id a detachment of this tenant. */
const assertGrantInput = async (tenant, keys, detachmentIds = []) => {
  const allowed = new Set(assignableKeys(tenant));
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length) {
    throw AppError.validation({ capabilityKeys: `Not assignable to a Simple Admin in this team: ${bad.join(', ')}.` });
  }
  if (detachmentIds.length) {
    const found = await Detachment.find({ tenantId: String(tenant._id), _id: { $in: detachmentIds } }).select('_id');
    const known = new Set(found.map((d) => String(d._id)));
    const unknown = detachmentIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw AppError.validation({ detachmentIds: `Unknown detachment(s): ${unknown.join(', ')}.` });
    }
  }
};

const stale = (current) =>
  new AppError('stale_admin_management', 409, 'The admin list changed since you read it.', { currentRevision: current });

/**
 * Bump the tenant's management revision inside `session`. With `expected`,
 * the bump is a compare-and-set that fails with stale_admin_management.
 * Returns the new revision.
 */
const bumpRevision = async (tenantId, expected, session) => {
  const filter = { _id: tenantId };
  if (expected !== undefined && expected !== null) filter.adminManagementRevision = expected;
  const doc = await SaasTenant.findOneAndUpdate(filter, { $inc: { adminManagementRevision: 1 } }, { new: true, session }).select(
    'adminManagementRevision',
  );
  if (!doc) {
    const current = await SaasTenant.findById(tenantId).select('adminManagementRevision').session(session || null);
    throw stale(current ? current.adminManagementRevision : null);
  }
  return doc.adminManagementRevision;
};

/** Early, non-transactional stale check (the transactional CAS is the real guard). */
const assertRevision = (tenant, expected) => {
  if (tenant.adminManagementRevision !== expected) throw stale(tenant.adminManagementRevision);
};

// ---- reads ------------------------------------------------------------------------------

const snapshot = async (tenant) => {
  const tenantId = String(tenant._id);
  const [accounts, invitations] = await Promise.all([
    Account.find({ saasTenantId: tenantId, role: 'admin', status: { $ne: 'revoked' } }).sort({ createdAt: 1, _id: 1 }),
    Authorization.find({ tenantId, kind: 'simple_admin' }).sort({ createdAt: -1, _id: -1 }),
  ]);
  const now = new Date();
  return {
    revision: tenant.adminManagementRevision,
    accounts: accounts.map(accountJson),
    invitations: invitations.map((az) => invitationJson(az, now)),
    assignableKeys: assignableKeys(tenant),
    readAt: now.toISOString(),
  };
};

// ---- invitations ------------------------------------------------------------------------

const invite = async (tenant, actor, body) => {
  const address = normEmail(body.invitedEmail ?? body.email);
  if (!isEmail(address)) throw AppError.validation({ invitedEmail: 'A valid email address is required.' });
  const suggestedName = collapse(body.suggestedName);
  const keys = [...new Set(body.capabilityKeys)];
  const detachmentIds = [...new Set(body.detachmentIds || [])];
  await assertGrantInput(tenant, keys, detachmentIds);
  assertRevision(tenant, body.expectedRevision);

  const tenantId = String(tenant._id);
  const [existingAccount, pending] = await Promise.all([
    Account.exists({ email: address }),
    Authorization.findOne({ tenantId, kind: 'simple_admin', email: address, status: 'pending', expiresAt: { $gt: new Date() } }),
  ]);
  if (existingAccount || pending) {
    throw new AppError('admin_invitation_exists', 409, 'An account or a pending invitation already exists for this address.');
  }
  await usageService.assertCanConsume(tenant, 'admins');

  const grant = caps.grantFromKeys(keys, detachmentIds);
  const expiresAt = await authorizationService.invitationExpiry();
  const az = await withTransaction(async (session) => {
    await bumpRevision(tenantId, body.expectedRevision, session);
    const [created] = await Authorization.create(
      [
        {
          tenantId,
          kind: 'simple_admin',
          role: 'admin',
          email: address,
          capabilities: grant,
          suggestedName,
          expiresAt,
          lastSentAt: new Date(),
          createdBy: { accountId: String(actor._id), displayName: actor.name || '' },
        },
      ],
      { session },
    );
    await auditService.record({
      stream: 'tenant',
      action: 'admin_invitation_created',
      actor,
      target: { type: 'simple_admin_invitation', id: String(created._id), displayName: suggestedName },
      tenant,
      changes: [
        { field: 'invitation_status', after: 'pending' },
        { field: 'capability_grant', after: grantKeys(grant) },
      ],
      session,
    });
    return created;
  });
  await emailService.sendTemplate(
    address,
    'simpleAdminInvitation',
    { tenantName: tenant.displayName, inviterName: actor.name || '' },
    { tenantId, authorizationId: String(az._id) },
  );
  return invitationJson(az);
};

const loadInvitation = async (tenant, invitationId) => {
  const az = await Authorization.findOne({ _id: invitationId, tenantId: String(tenant._id), kind: 'simple_admin' });
  if (!az) throw AppError.notFound('invitation');
  return az;
};

const cancelInvitation = async (tenant, actor, invitationId, { expectedRevision }) => {
  const existing = await loadInvitation(tenant, invitationId);
  if (existing.status !== 'pending') {
    throw AppError.conflict(`The invitation is ${existing.effectiveStatus()} and cannot be cancelled.`, { invitationStatus: existing.effectiveStatus() });
  }
  assertRevision(tenant, expectedRevision);
  const tenantId = String(tenant._id);

  const az = await withTransaction(async (session) => {
    await bumpRevision(tenantId, expectedRevision, session);
    const now = new Date();
    const updated = await Authorization.findOneAndUpdate(
      { _id: existing._id, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { new: true, session },
    );
    if (!updated) throw AppError.conflict('The invitation is no longer pending.');
    if (updated.linkedAccountId) {
      // The linked identity has not finished setup (else the invitation would be accepted).
      await Account.updateOne(
        { _id: updated.linkedAccountId, setupCompleted: { $ne: true }, linkedAuthorizationId: String(updated._id) },
        { $set: { linkStatus: 'withdrawn', linkedAuthorizationId: null } },
        { session },
      );
    }
    await auditService.record({
      stream: 'tenant',
      action: 'admin_invitation_cancelled',
      actor,
      target: { type: 'simple_admin_invitation', id: String(updated._id), displayName: updated.suggestedName },
      tenant,
      changes: [{ field: 'invitation_status', before: 'pending', after: 'cancelled' }],
      session,
    });
    return updated;
  });
  return invitationJson(az);
};

const resendInvitation = async (tenant, actor, invitationId) => {
  const existing = await loadInvitation(tenant, invitationId);
  if (!['pending', 'expired'].includes(existing.status)) {
    throw AppError.conflict(`The invitation is ${existing.status} and cannot be resent.`, { invitationStatus: existing.status });
  }
  const expiresAt = await authorizationService.invitationExpiry();
  const tenantId = String(tenant._id);
  const az = await withTransaction(async (session) => {
    const updated = await Authorization.findOneAndUpdate(
      { _id: existing._id, status: { $in: ['pending', 'expired'] } },
      { $set: { status: 'pending', expiresAt, lastSentAt: new Date() } },
      { new: true, session },
    );
    if (!updated) throw AppError.conflict('The invitation can no longer be resent.');
    await bumpRevision(tenantId, null, session);
    return updated;
  });
  await emailService.sendTemplate(
    az.email,
    'simpleAdminInvitation',
    { tenantName: tenant.displayName, inviterName: actor.name || '' },
    { tenantId, authorizationId: String(az._id) },
  );
  return invitationJson(az);
};

// ---- accounts ------------------------------------------------------------------------------

/**
 * The target of an account command: a tenant admin of THIS tenant.
 * Unknown / other tenant / not an administrator → 404; self → 409;
 * the Main Admin → 403 (the seat is platform-managed).
 */
const loadTarget = async (tenant, actor, accountId) => {
  const target = await Account.findOne({
    _id: accountId,
    saasTenantId: String(tenant._id),
    role: { $in: ['admin', 'main_admin'] },
    status: { $ne: 'revoked' },
  });
  if (!target) throw AppError.notFound('account');
  if (String(target._id) === String(actor._id)) throw AppError.conflict('You cannot change your own administrator account.');
  if (target.role !== 'admin') throw AppError.notPermitted('The Main Admin is managed by the platform.');
  return target;
};

const updateCapabilities = async (tenant, actor, accountId, body) => {
  const target = await loadTarget(tenant, actor, accountId);
  const keys = [...new Set(body.capabilityKeys)];
  const detachmentIds = [...new Set(body.detachmentIds || [])];
  await assertGrantInput(tenant, keys, detachmentIds);
  assertRevision(tenant, body.expectedRevision);
  const before = grantKeys(target.capabilities);
  const grant = caps.grantFromKeys(keys, detachmentIds);

  await withTransaction(async (session) => {
    await bumpRevision(String(tenant._id), body.expectedRevision, session);
    target.capabilities = grant;
    await target.save({ session });
    await auditService.record({
      stream: 'tenant',
      action: 'admin_capabilities_changed',
      actor,
      target: { type: 'simple_admin_account', id: String(target._id), displayName: target.name || '' },
      tenant,
      changes: [{ field: 'capability_grant', before, after: grantKeys(grant) }],
      session,
    });
  });
  return accountJson(target);
};

const setStatus = async (tenant, actor, accountId, next, { reason } = {}) => {
  const target = await loadTarget(tenant, actor, accountId);
  const from = next === 'suspended' ? 'active' : 'suspended';
  if (target.status !== from) {
    throw AppError.conflict(`Only a ${from} administrator can be ${next === 'suspended' ? 'suspended' : 'reactivated'}.`, {
      accountStatus: target.status,
    });
  }
  await withTransaction(async (session) => {
    target.status = next;
    target.suspension = next === 'suspended' ? { suspendedAt: new Date(), reason: collapse(reason) } : undefined;
    await target.save({ session });
    if (next === 'suspended') await tokenService.revokeAllForAccount(target._id, 'account_suspended', { session });
    await bumpRevision(String(tenant._id), null, session);
    await auditService.record({
      stream: 'tenant',
      action: next === 'suspended' ? 'admin_suspended' : 'admin_reactivated',
      actor,
      target: { type: 'simple_admin_account', id: String(target._id), displayName: target.name || '' },
      tenant,
      changes: [{ field: 'account_status', before: from, after: next }],
      session,
    });
  });
  return accountJson(target);
};

module.exports = {
  invitationJson,
  accountJson,
  grantKeys,
  assignableKeys,
  snapshot,
  invite,
  cancelInvitation,
  resendInvitation,
  updateCapabilities,
  suspend: (tenant, actor, accountId, body) => setStatus(tenant, actor, accountId, 'suspended', body),
  reactivate: (tenant, actor, accountId) => setStatus(tenant, actor, accountId, 'active'),
};
