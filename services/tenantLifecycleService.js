/**
 * SaasTenant operational lifecycle (API_CONTRACT.md → "Tenant operational
 * lifecycle (Point 9)") — the sole legal transition table, the Team Code
 * availability rules and the final destructive deletion.
 *
 *   active            ─suspend──────────▶ suspended          (reason)
 *   suspended         ─reactivate───────▶ active
 *   active|suspended  ─deletion/begin───▶ deletion_pending   (reason; remembers previousStatus)
 *   deletion_pending  ─deletion/cancel──▶ previousStatus     (only while now < scheduledFor)
 *   deletion_pending  ─deletion/finalize▶ deleted            (only when now ≥ scheduledFor)
 *   anything else     → 409 invalid_tenant_transition
 *
 * The lifecycle NEVER touches the subscription, features, limits, Team Code,
 * Main Admin association or sessions. Only final deletion removes data.
 *
 * Check order of every command: tenant (404 tenant_not_found / 409
 * tenant_already_deleted) → reason (422 invalid_lifecycle_reason) → version
 * (409 stale_tenant) → transition (409 invalid_tenant_transition) → window
 * (409 deletion_window_expired / deletion_not_effective).
 */
const {
  SaasTenant,
  TenantStatusEvent,
  TenantTombstone,
  RetiredTeamCode,
  BreakGlassGrant,
  Account,
  Authorization,
  Counter,
  DetachmentGroup,
  Detachment,
  TeamMember,
  Shift,
  ShiftTemplate,
  InventoryItem,
  InventoryMovement,
  Workshop,
  WorkshopParticipant,
  Announcement,
  NotificationState,
  ChangeLog,
  BillingOrder,
} = require('../models');
const AppError = require('../utils/appError');
const { reason: normReason, generateTeamCode } = require('../utils/normalize');
const { sha256 } = require('../utils/ids');
const { REASON_MAX } = require('../config/constants');
const { withTransaction } = require('./txn');
const settingsService = require('./settingsService');
const auditService = require('./auditService');
const tokenService = require('./tokenService');
const storageService = require('./storageService');
const { serializeLifecycle } = require('./tenantView');

const DAY_MS = 86400000;

// ---- loading -------------------------------------------------------------------------

/**
 * Load a live SaasTenant or throw.
 * @param {string} tenantId
 * @param {object} opts
 * @param {object} [opts.session]
 * @param {string} [opts.missingCode='tenant_not_found']  404 code for an unknown id
 * @param {string|null} [opts.tombstoneCode='tenant_already_deleted']  409 code when a
 *   tombstone exists; `null` treats a tombstoned id as unknown (404).
 */
const loadTenant = async (tenantId, { session, missingCode = 'tenant_not_found', tombstoneCode = 'tenant_already_deleted' } = {}) => {
  const id = String(tenantId);
  const tenant = await SaasTenant.findById(id).session(session || null);
  if (tenant) return tenant;
  if (tombstoneCode) {
    const tomb = await TenantTombstone.exists({ _id: id }).session(session || null);
    if (tomb) throw new AppError(tombstoneCode, 409, 'The team was deleted.');
  }
  throw new AppError(missingCode, 404, 'tenant not found');
};

// ---- status history -------------------------------------------------------------------

/** Append one compact lifecycle-history row. */
const recordEvent = async (tenantId, type, note, { session, occurredAt } = {}) => {
  const [evt] = await TenantStatusEvent.create(
    [{ tenantId: String(tenantId), type, note: note || null, occurredAt: occurredAt || new Date() }],
    { session },
  );
  return evt;
};

// ---- Team Code -------------------------------------------------------------------------

const isRetiredCode = async (code, { session } = {}) =>
  !!(await RetiredTeamCode.exists({ _id: sha256(code) }).session(session || null));

const isTakenCode = async (code, { session } = {}) => !!(await SaasTenant.exists({ teamCode: code }).session(session || null));

/** 409 tenant_code_conflict when the canonical code is in use or retired. */
const assertTeamCodeAvailable = async (code, { session } = {}) => {
  if ((await isTakenCode(code, { session })) || (await isRetiredCode(code, { session }))) {
    throw new AppError('tenant_code_conflict', 409, 'This Team Code is not available.', { fields: { teamCode: 'This Team Code is not available.' } });
  }
};

/** A fresh canonical code that is neither used nor retired. */
const suggestTeamCode = async ({ session } = {}) => {
  for (let i = 0; i < 25; i += 1) {
    const code = generateTeamCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTakenCode(code, { session })) && !(await isRetiredCode(code, { session }))) return code;
  }
  throw new AppError('server', 500, 'Could not generate a free Team Code.');
};

// ---- side effects ----------------------------------------------------------------------

/** End every active break-glass grant of the tenant (it is no longer eligible). */
const endBreakGlassGrants = (tenantId, { session, now = new Date() } = {}) =>
  BreakGlassGrant.updateMany(
    { 'tenant.tenantId': String(tenantId), status: 'active' },
    { $set: { status: 'ended', endReason: 'tenant_unavailable', endedAt: now }, $inc: { revision: 1 } },
    { session },
  );

/** Tenant-plane collections removed by final deletion (every document carries tenantId). */
const TENANT_PLANE_MODELS = [
  DetachmentGroup,
  Detachment,
  TeamMember,
  Shift,
  ShiftTemplate,
  InventoryItem,
  InventoryMovement,
  Workshop,
  WorkshopParticipant,
  Announcement,
  NotificationState,
  ChangeLog,
  Authorization,
  BillingOrder,
];

/** Every Account that belongs to the tenant: its administrators and the seat accounts it provisioned. */
const tenantAccountIds = async (tenant, { session } = {}) => {
  const tenantId = String(tenant._id);
  const ids = new Set();
  const members = await Account.find({ saasTenantId: tenantId }, { _id: 1 }).session(session || null);
  members.forEach((a) => ids.add(String(a._id)));
  const seats = await Authorization.find({ tenantId, kind: { $in: ['initial_seat', 'replacement_designate'] } }, { accountId: 1 }).session(
    session || null,
  );
  seats.forEach((az) => az.accountId && ids.add(String(az.accountId)));
  if (tenant.seat && tenant.seat.currentAccountId) ids.add(String(tenant.seat.currentAccountId));
  if (tenant.seat && tenant.seat.replacement && tenant.seat.replacement.designateAccountId) {
    ids.add(String(tenant.seat.replacement.designateAccountId));
  }
  if (!ids.size) return [];
  // Never a platform or demo identity, whatever a stale reference says.
  const owned = await Account.find({ _id: { $in: [...ids] }, role: { $nin: ['super_admin', 'customer_demo'] } }, { _id: 1 }).session(
    session || null,
  );
  return owned.map((a) => String(a._id));
};

/**
 * The destructive cascade, inside the caller's transaction. Files on disk are
 * removed AFTER commit by `purgeTenantFiles` (a disk delete cannot roll back).
 * Returns the TenantTombstone document.
 */
const finalizeDeletion = async (tenant, actor, { session, now = new Date() } = {}) => {
  const tenantId = String(tenant._id);
  const displayName = tenant.displayName;

  // 1. Accounts: end every session, then delete the accounts.
  const accountIds = await tenantAccountIds(tenant, { session });
  for (const accountId of accountIds) {
    // eslint-disable-next-line no-await-in-loop
    await tokenService.revokeAllForAccount(accountId, 'tenant_deleted', { session });
  }
  if (accountIds.length) await Account.deleteMany({ _id: { $in: accountIds } }, { session });

  // 2. Every tenant-plane document (bulk delete: the change log goes too).
  for (const Model of TENANT_PLANE_MODELS) {
    // eslint-disable-next-line no-await-in-loop
    await Model.deleteMany({ tenantId }, { session });
  }
  await Counter.deleteOne({ _id: `changelog:${tenantId}` }, { session });

  // 3. The Team Code can never resolve or be reused.
  await RetiredTeamCode.updateOne({ _id: sha256(tenant.teamCode) }, { $setOnInsert: { retiredAt: now } }, { upsert: true, session });

  // 4. History row, tombstone, then the tenant record itself.
  await recordEvent(tenantId, 'tenant_deleted', null, { session, occurredAt: now });
  const [tombstone] = await TenantTombstone.create(
    [
      {
        _id: tenantId,
        displayNameSnapshot: displayName,
        status: 'deleted',
        deletedAt: now,
        lifecycleVersion: tenant.lifecycle.version,
        historyReference: `tenant-lifecycle:${tenantId}`,
      },
    ],
    { session },
  );
  await SaasTenant.deleteOne({ _id: tenantId }, { session });

  await auditService.record({
    action: 'deletion_finalized',
    actor,
    target: { type: 'tenant_lifecycle', id: tenantId, displayName },
    tenant: { id: tenantId, displayName, isDeleted: true },
    changes: [{ field: 'lifecycle_status', before: 'deletion_pending', after: 'deleted' }],
    session,
  });
  return tombstone;
};

/** Remove the tenant's uploaded files (disk + ledger). Best effort, after commit. */
const purgeTenantFiles = async (tenantId) => {
  try {
    await storageService.removeTenantFiles(String(tenantId));
  } catch (err) {
    // The tenant is already gone; a leftover file is a janitorial problem, not a failed deletion.
    // eslint-disable-next-line no-console
    if (process.env.NODE_ENV !== 'test') console.error(`[lifecycle] file purge failed for ${tenantId}:`, err.message);
  }
};

// ---- the state machine ------------------------------------------------------------------

const unset = (tenant, path) => tenant.set(path, undefined);

const COMMANDS = {
  suspend: {
    from: ['active'],
    needsReason: true,
    event: 'tenant_suspended',
    audit: 'tenant_suspended',
    apply(tenant, { reason, now }) {
      tenant.lifecycle.status = 'suspended';
      tenant.lifecycle.suspension = { suspendedAt: now, reason };
    },
  },
  reactivate: {
    from: ['suspended'],
    event: 'tenant_reactivated',
    audit: 'tenant_reactivated',
    apply(tenant) {
      tenant.lifecycle.status = 'active';
      unset(tenant, 'lifecycle.suspension');
    },
  },
  beginDeletion: {
    from: ['active', 'suspended'],
    needsReason: true,
    event: 'deletion_requested',
    audit: 'deletion_requested',
    apply(tenant, { reason, now, settings }) {
      const previousStatus = tenant.lifecycle.status;
      tenant.lifecycle.deletion = {
        requestedAt: now,
        scheduledFor: new Date(now.getTime() + settings.deletionWindowDays * DAY_MS),
        previousStatus,
        reason,
      };
      // Suspension metadata survives only when the tenant WAS suspended, so cancel restores it exactly.
      if (previousStatus !== 'suspended') unset(tenant, 'lifecycle.suspension');
      tenant.lifecycle.status = 'deletion_pending';
    },
  },
  cancelDeletion: {
    from: ['deletion_pending'],
    event: 'deletion_cancelled',
    audit: 'deletion_cancelled',
    guard(tenant, { now }) {
      const scheduledFor = tenant.lifecycle.deletion && tenant.lifecycle.deletion.scheduledFor;
      if (scheduledFor && now.getTime() >= new Date(scheduledFor).getTime()) {
        throw new AppError('deletion_window_expired', 409, 'The deletion window has passed; it can no longer be cancelled.');
      }
    },
    apply(tenant) {
      const previous = (tenant.lifecycle.deletion && tenant.lifecycle.deletion.previousStatus) || 'active';
      tenant.lifecycle.status = previous;
      if (previous !== 'suspended') unset(tenant, 'lifecycle.suspension');
      unset(tenant, 'lifecycle.deletion');
    },
  },
  finalizeDeletion: {
    from: ['deletion_pending'],
    event: 'tenant_deleted',
    audit: 'deletion_finalized',
    guard(tenant, { now }) {
      const scheduledFor = tenant.lifecycle.deletion && tenant.lifecycle.deletion.scheduledFor;
      if (!scheduledFor || now.getTime() < new Date(scheduledFor).getTime()) {
        throw new AppError('deletion_not_effective', 409, 'The deletion is not effective yet.', {
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        });
      }
    },
  },
};

const lifecycleReason = (value) => {
  const r = typeof value === 'string' ? normReason(value, REASON_MAX) : null;
  if (!r) throw new AppError('invalid_lifecycle_reason', 422, 'A reason of 1–280 characters is required.');
  return r;
};

/**
 * Run one lifecycle command atomically.
 * @param {'suspend'|'reactivate'|'beginDeletion'|'cancelDeletion'|'finalizeDeletion'} command
 * @param {string} tenantId
 * @param {{ expectedVersion: number, reason?: string }} body
 * @param actor Super Admin Account
 * @returns {{ tenantId, displayNameSnapshot, lifecycle, changed, tombstone? }}
 */
const runCommand = async (command, tenantId, body, actor) => {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`unknown lifecycle command ${command}`);
  const settings = await settingsService.get();

  const result = await withTransaction(async (session) => {
    const now = new Date();
    const tenant = await loadTenant(tenantId, { session });
    const reason = spec.needsReason ? lifecycleReason(body.reason) : null;

    if (tenant.lifecycle.version !== body.expectedVersion) {
      throw new AppError('stale_tenant', 409, 'The team changed since you read it.', {
        currentVersion: tenant.lifecycle.version,
        lifecycleStatus: tenant.lifecycle.status,
      });
    }
    const before = tenant.lifecycle.status;
    if (!spec.from.includes(before)) {
      throw new AppError('invalid_tenant_transition', 409, `Cannot ${command} a ${before} team.`, { lifecycleStatus: before });
    }
    if (spec.guard) spec.guard(tenant, { now });

    tenant.lifecycle.version += 1;
    const tid = String(tenant._id);

    if (command === 'finalizeDeletion') {
      const lifecycle = serializeLifecycle(
        { lifecycle: { ...tenant.toObject().lifecycle, status: 'deleted', version: tenant.lifecycle.version } },
        { deletedAt: now },
      );
      const tombstone = await finalizeDeletion(tenant, actor, { session, now });
      return { tenantId: tid, displayNameSnapshot: tenant.displayName, lifecycle, changed: true, tombstone: tombstone.toJSON() };
    }

    spec.apply(tenant, { reason, now, settings });
    await tenant.save({ session });

    if (command === 'suspend' || command === 'beginDeletion') await endBreakGlassGrants(tid, { session, now });

    await recordEvent(tid, spec.event, reason, { session, occurredAt: now });
    await auditService.record({
      action: spec.audit,
      actor,
      target: { type: 'tenant_lifecycle', id: tid, displayName: tenant.displayName },
      tenant,
      changes: [{ field: 'lifecycle_status', before, after: tenant.lifecycle.status }],
      session,
    });
    return { tenantId: tid, displayNameSnapshot: tenant.displayName, lifecycle: serializeLifecycle(tenant), changed: true };
  });

  if (command === 'finalizeDeletion') await purgeTenantFiles(result.tenantId);
  return result;
};

module.exports = {
  DAY_MS,
  COMMANDS,
  TENANT_PLANE_MODELS,
  loadTenant,
  recordEvent,
  isRetiredCode,
  isTakenCode,
  assertTeamCodeAvailable,
  suggestTeamCode,
  endBreakGlassGrants,
  tenantAccountIds,
  finalizeDeletion,
  purgeTenantFiles,
  runCommand,
};
