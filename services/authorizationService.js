/**
 * Authorizations: how a verified identity becomes an administrator of a tenant.
 *
 * Owns three invariants shared by onboarding and the control plane:
 *
 * 1. Main Admin SEAT (Point 14): every non-deleted tenant has exactly one
 *    current Main Admin account (pending_setup | active | suspended) and at
 *    most one pending replacement. Authority moves only atomically, when a
 *    designate completes setup. There is no stand-alone revoke.
 * 2. Simple Admin INVITATION (Point 18B): pending → accepted is consumed
 *    atomically inside setup completion; cancelled/expired are terminal.
 * 3. AUTO-LINK (Point 17C): on every authoritative read, a pending, unexpired
 *    Simple Admin invitation for the verified normalized address whose tenant
 *    is `active` links the account.
 */
const { Account, Authorization, SaasTenant } = require('../models');
const AppError = require('../utils/appError');
const { mainAdminGrant, normalizeGrant } = require('../config/capabilities');
const { collapse, email: normEmail, isEmail } = require('../utils/normalize');
const { newId } = require('../utils/ids');
const settingsService = require('./settingsService');
const emailService = require('./emailService');
const auditService = require('./auditService');
const tokenService = require('./tokenService');
const { REASON_MAX, DISPLAY_NAME_MAX } = require('../config/constants');

const SYSTEM = auditService.SYSTEM;

const invitationExpiry = async (now = new Date()) => {
  const s = await settingsService.get();
  return new Date(now.getTime() + s.invitationDays * 86400000);
};

// ---------------------------------------------------------------------------
// Onboarding side
// ---------------------------------------------------------------------------

/**
 * Re-evaluate the account's link (withdrawn if its authorization no longer
 * stands) and auto-link a Simple Admin invitation. Mutates + saves `account`.
 * Returns the account.
 */
const refreshLinkState = async (account, { session } = {}) => {
  if (account.setupCompleted || !account.emailVerified) return account;
  const now = new Date();

  if (account.linkStatus === 'linked' && account.linkedAuthorizationId) {
    const az = await Authorization.findById(account.linkedAuthorizationId).session(session || null);
    const tenant = az ? await SaasTenant.findById(az.tenantId).session(session || null) : null;
    const stillStands = az && tenant && az.status === 'pending';
    if (!stillStands) {
      account.linkStatus = 'withdrawn';
      account.linkedAuthorizationId = null;
      await account.save({ session });
    }
  }

  if (account.linkStatus !== 'linked') {
    const candidates = await Authorization.find({ email: account.email, kind: 'simple_admin', status: 'pending' })
      .sort({ createdAt: -1 })
      .session(session || null);
    for (const az of candidates) {
      if (az.expiresAt && az.expiresAt <= now) continue;
      const tenant = await SaasTenant.findById(az.tenantId).session(session || null);
      if (!tenant || tenant.lifecycle.status !== 'active') continue;
      account.linkStatus = 'linked';
      account.linkedAuthorizationId = String(az._id);
      await account.save({ session });
      az.linkedAccountId = String(account._id);
      await az.save({ session });
      break;
    }
  }
  return account;
};

/** Validate a display name for setup: 1–80 after whitespace collapse. */
const normalizeDisplayName = (value) => {
  const name = collapse(value);
  if (!name || name.length > DISPLAY_NAME_MAX) return null;
  return name;
};

/**
 * Complete account setup: the ONE atomic transition from a linked identity
 * to an administrator. Caller wraps it in a transaction and issues the full
 * session afterwards.
 */
const completeSetup = async (account, displayNameInput, { session } = {}) => {
  const displayName = normalizeDisplayName(displayNameInput);
  if (!displayName) throw AppError.validation({ displayName: 'Display name must be 1–80 characters.' });

  if (account.status === 'suspended' || account.status === 'revoked') {
    throw new AppError('account_unavailable', 403, 'This account is not available.');
  }
  if (account.setupCompleted) throw new AppError('setup_already_completed', 409, 'Setup is already completed.');
  if (account.linkStatus !== 'linked' || !account.linkedAuthorizationId) {
    throw new AppError('setup_unavailable', 409, 'There is no linked authorization to complete.');
  }

  const az = await Authorization.findById(account.linkedAuthorizationId).session(session || null);
  if (!az || az.status !== 'pending') throw new AppError('setup_unavailable', 409, 'The authorization was withdrawn.');
  if (az.expiresAt && az.expiresAt <= new Date()) {
    throw new AppError('invitation_expired', 409, 'The invitation has expired.');
  }
  const tenant = await SaasTenant.findById(az.tenantId).session(session || null);
  if (!tenant) throw new AppError('setup_unavailable', 409, 'The team no longer exists.');
  if (tenant.lifecycle.status !== 'active') {
    throw new AppError('tenant_unavailable', 409, 'The team is not active.', { tenantStatus: tenant.lifecycle.status });
  }

  const now = new Date();
  account.name = displayName;
  account.saasTenantId = String(tenant._id);
  account.setupCompleted = true;
  account.status = 'active';
  account.activatedAt = now;
  account.provisioned = false;

  if (az.kind === 'simple_admin') {
    account.role = 'admin';
    account.capabilities = normalizeGrant(az.capabilities);
    await account.save({ session });
    az.status = 'accepted';
    az.acceptedAt = now;
    az.linkedAccountId = String(account._id);
    await az.save({ session });
    tenant.adminManagementRevision += 1;
    await tenant.save({ session });
    await auditService.record({
      stream: 'tenant',
      action: 'admin_invitation_accepted',
      actor: SYSTEM,
      target: { type: 'simple_admin_invitation', id: String(az._id) },
      tenant,
      changes: [
        { field: 'invitation_status', before: 'pending', after: 'accepted' },
        { field: 'login_identity', before: 'x', after: 'x' },
      ],
      session,
    });
    return { account, tenant, authorization: az };
  }

  // Seat kinds → Main Admin
  account.role = 'main_admin';
  account.capabilities = mainAdminGrant();
  await account.save({ session });
  az.status = 'accepted';
  az.acceptedAt = now;
  az.linkedAccountId = String(account._id);
  await az.save({ session });

  if (az.kind === 'initial_seat') {
    tenant.seat.currentAccountId = String(account._id);
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await auditService.record({
      action: 'main_admin_setup_completed',
      actor: SYSTEM,
      target: { type: 'main_admin_account', id: String(account._id) },
      tenant,
      changes: [{ field: 'account_status', before: 'pending_setup', after: 'active' }],
      session,
    });
  } else {
    // replacement_designate: atomic transfer.
    const formerId = tenant.seat.currentAccountId;
    if (formerId && formerId !== String(account._id)) {
      const former = await Account.findById(formerId).session(session || null);
      if (former) {
        const before = former.status;
        former.status = 'revoked';
        former.revokedAt = now;
        await former.save({ session });
        await tokenService.revokeAllForAccount(former._id, 'main_admin_replaced', { session });
        await auditService.record({
          action: 'main_admin_replaced',
          actor: SYSTEM,
          target: { type: 'main_admin_account', id: String(account._id) },
          tenant,
          changes: [
            { field: 'account_status', before, after: 'revoked' },
            { field: 'login_identity', before: 'x', after: 'x' },
          ],
          session,
        });
      }
    }
    tenant.seat.currentAccountId = String(account._id);
    tenant.seat.replacement = undefined;
    tenant.seat.revision += 1;
    await tenant.save({ session });
  }
  return { account, tenant, authorization: az };
};

// ---------------------------------------------------------------------------
// Control-plane side: provisioning + the Main Admin seat
// ---------------------------------------------------------------------------

const assertIdentityAvailable = async (address, { session } = {}) => {
  const existing = await Account.findOne({ email: address }).session(session || null);
  if (existing) {
    throw new AppError('main_admin_identity_unavailable', 409, 'This address cannot be designated.');
  }
};

/** Provision a pending_setup account + seat authorization and mail the setup invitation. */
const provisionSeatAccount = async ({ tenant, name, email, kind, createdBy, session }) => {
  const address = normEmail(email);
  if (!isEmail(address)) throw AppError.validation({ loginEmail: 'A valid email is required.' });
  await assertIdentityAvailable(address, { session });
  const [account] = await Account.create(
    [
      {
        email: address,
        name: collapse(name),
        status: 'pending_setup',
        provisioned: true,
        emailVerified: false,
        linkStatus: 'unlinked',
      },
    ],
    { session },
  );
  const expiresAt = await invitationExpiry();
  const [az] = await Authorization.create(
    [
      {
        tenantId: String(tenant._id),
        kind,
        email: address,
        role: 'main_admin',
        capabilities: mainAdminGrant(),
        suggestedName: collapse(name),
        accountId: String(account._id),
        expiresAt,
        lastSentAt: new Date(),
        createdBy: createdBy ? { accountId: String(createdBy._id), displayName: createdBy.name } : undefined,
      },
    ],
    { session },
  );
  await emailService.sendTemplate(address, 'mainAdminSetup', { tenantName: tenant.displayName, expiresAt }, { tenantId: String(tenant._id) });
  return { account, authorization: az };
};

/** Latest seat authorization for an account (for setup state). */
const seatAuthorizationFor = (accountId, { session } = {}) =>
  Authorization.findOne({ accountId: String(accountId), kind: { $in: ['initial_seat', 'replacement_designate'] } })
    .sort({ createdAt: -1 })
    .session(session || null);

const setupStateOf = (az) => {
  if (!az) return { status: 'expired', lastSentAt: new Date(0).toISOString() };
  const expired = az.expiresAt && az.expiresAt <= new Date();
  const out = { status: expired || az.status === 'expired' ? 'expired' : 'outstanding', lastSentAt: az.lastSentAt.toISOString() };
  if (az.expiresAt) out.expiresAt = az.expiresAt.toISOString();
  return out;
};

/** GET /platform/tenants/:id/main-admin — the seat snapshot. */
const seatSnapshot = async (tenant) => {
  const current = tenant.seat.currentAccountId ? await Account.findById(tenant.seat.currentAccountId) : null;
  const out = {
    tenant: {
      tenantId: String(tenant._id),
      displayName: tenant.displayName,
      lifecycleStatus: tenant.lifecycle.status,
      lifecycleVersion: tenant.lifecycle.version,
    },
    revision: tenant.seat.revision,
    readAt: new Date().toISOString(),
  };
  if (current) {
    const c = {
      accountId: String(current._id),
      displayName: current.name,
      loginEmail: current.email,
      status: current.status === 'revoked' ? 'suspended' : current.status,
      createdAt: current.createdAt.toISOString(),
    };
    if (current.status === 'pending_setup') c.setup = setupStateOf(await seatAuthorizationFor(current._id));
    else c.activatedAt = (current.activatedAt || current.createdAt).toISOString();
    if (current.status === 'suspended') {
      c.suspension = {
        suspendedAt: (current.suspension?.suspendedAt || new Date()).toISOString(),
        reason: current.suspension?.reason || '',
      };
    }
    out.current = c;
  }
  const rep = tenant.seat.replacement;
  if (rep && rep.status === 'pending') {
    const designate = await Account.findById(rep.designateAccountId);
    const az = rep.authorizationId ? await Authorization.findById(rep.authorizationId) : null;
    out.replacement = {
      id: rep.id,
      status: 'pending',
      designate: {
        accountId: String(rep.designateAccountId),
        displayName: designate ? designate.name : '',
        loginEmail: designate ? designate.email : '',
        setup: setupStateOf(az),
      },
      requestedAt: rep.requestedAt.toISOString(),
      reason: rep.reason,
    };
  }
  return out;
};

const assertRevision = (tenant, expectedRevision) => {
  if (!Number.isInteger(expectedRevision)) throw AppError.validation({ expectedRevision: 'expectedRevision is required.' });
  if (tenant.seat.revision !== expectedRevision) {
    throw new AppError('stale_main_admin', 409, 'The seat changed since you read it.', { currentRevision: tenant.seat.revision });
  }
};

const assertTenantFor = (tenant, opensAccess) => {
  const s = tenant.lifecycle.status;
  if (s === 'deleted') throw new AppError('tenant_already_deleted', 409, 'The team was deleted.');
  if (opensAccess && s !== 'active') throw new AppError('tenant_not_eligible', 409, 'The team must be active.', { tenantStatus: s });
};

const normReason = (value) => {
  const r = collapse(value);
  if (!r || r.length > REASON_MAX) throw new AppError('invalid_main_admin_reason', 422, 'A reason of 1–280 characters is required.');
  return r;
};

/**
 * Seat commands. Each returns { effect, changed } after saving; the caller
 * reloads the snapshot. `actor` is the Super Admin Account.
 */
const seatCommands = {
  async resendSetup(tenant, { target = 'current' }, actor, { session } = {}) {
    assertTenantFor(tenant, true);
    let accountId;
    if (target === 'replacement') {
      if (!tenant.seat.replacement || tenant.seat.replacement.status !== 'pending') {
        throw new AppError('invalid_main_admin_transition', 409, 'There is no pending replacement.');
      }
      accountId = tenant.seat.replacement.designateAccountId;
    } else {
      const current = await Account.findById(tenant.seat.currentAccountId).session(session || null);
      if (!current || current.status !== 'pending_setup') {
        throw new AppError('invalid_main_admin_transition', 409, 'The current Main Admin has already completed setup.');
      }
      accountId = current._id;
    }
    const az = await seatAuthorizationFor(accountId, { session });
    if (!az) throw new AppError('invalid_main_admin_transition', 409, 'No setup invitation exists.');
    az.status = 'pending';
    az.lastSentAt = new Date();
    az.expiresAt = await invitationExpiry();
    await az.save({ session });
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await emailService.sendTemplate(az.email, 'mainAdminSetup', { tenantName: tenant.displayName, expiresAt: az.expiresAt });
    await auditService.record({ action: 'main_admin_setup_resent', actor, target: { type: 'main_admin_account', id: String(accountId) }, tenant, session });
    return { effect: 'setup_resent' };
  },

  async suspend(tenant, { reason }, actor, { session } = {}) {
    assertTenantFor(tenant, false);
    const r = normReason(reason);
    const current = await Account.findById(tenant.seat.currentAccountId).session(session || null);
    if (!current || current.status !== 'active') {
      throw new AppError('invalid_main_admin_transition', 409, 'Only an active Main Admin can be suspended.');
    }
    current.status = 'suspended';
    current.suspension = { suspendedAt: new Date(), reason: r };
    await current.save({ session });
    await tokenService.revokeAllForAccount(current._id, 'account_suspended', { session });
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await auditService.record({
      action: 'main_admin_suspended',
      actor,
      target: { type: 'main_admin_account', id: String(current._id) },
      tenant,
      changes: [{ field: 'account_status', before: 'active', after: 'suspended' }],
      session,
    });
    return { effect: 'suspended' };
  },

  async reactivate(tenant, _body, actor, { session } = {}) {
    assertTenantFor(tenant, true);
    const current = await Account.findById(tenant.seat.currentAccountId).session(session || null);
    if (!current || current.status !== 'suspended') {
      throw new AppError('invalid_main_admin_transition', 409, 'Only a suspended Main Admin can be reactivated.');
    }
    current.status = 'active';
    current.suspension = undefined;
    await current.save({ session });
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await auditService.record({
      action: 'main_admin_reactivated',
      actor,
      target: { type: 'main_admin_account', id: String(current._id) },
      tenant,
      changes: [{ field: 'account_status', before: 'suspended', after: 'active' }],
      session,
    });
    return { effect: 'reactivated' };
  },

  async replace(tenant, { designate = {}, reason }, actor, { session } = {}) {
    assertTenantFor(tenant, true);
    const r = normReason(reason);
    const name = collapse(designate.displayName);
    const address = normEmail(designate.loginEmail);
    if (!name || name.length > DISPLAY_NAME_MAX || !isEmail(address)) {
      throw new AppError('invalid_main_admin_identity', 422, 'A display name and a valid email are required.');
    }
    if (tenant.seat.replacement && tenant.seat.replacement.status === 'pending') {
      throw new AppError('main_admin_replacement_already_pending', 409, 'A replacement is already pending.');
    }
    const current = await Account.findById(tenant.seat.currentAccountId).session(session || null);
    if (current && current.email === address) {
      throw new AppError('invalid_main_admin_identity', 422, 'The designate must differ from the current Main Admin.');
    }

    if (!current || current.status === 'pending_setup') {
      // Immediate: nothing to transfer — revoke the never-activated account.
      const { account } = await provisionSeatAccount({ tenant, name, email: address, kind: 'initial_seat', createdBy: actor, session });
      if (current) {
        current.status = 'revoked';
        current.revokedAt = new Date();
        await current.save({ session });
        await tokenService.revokeAllForAccount(current._id, 'main_admin_replaced', { session });
        await Authorization.updateMany(
          { accountId: String(current._id), status: 'pending' },
          { $set: { status: 'withdrawn', withdrawnAt: new Date() } },
          { session },
        );
      }
      tenant.seat.currentAccountId = String(account._id);
      tenant.seat.revision += 1;
      await tenant.save({ session });
      await auditService.record({
        action: 'main_admin_replaced',
        actor,
        target: { type: 'main_admin_account', id: String(account._id) },
        tenant,
        changes: [
          { field: 'account_status', before: 'pending_setup', after: 'revoked' },
          { field: 'login_identity', before: 'x', after: 'x' },
        ],
        session,
      });
      return { effect: 'replaced' };
    }

    const { account, authorization } = await provisionSeatAccount({
      tenant,
      name,
      email: address,
      kind: 'replacement_designate',
      createdBy: actor,
      session,
    });
    tenant.seat.replacement = {
      id: newId('mar'),
      status: 'pending',
      designateAccountId: String(account._id),
      authorizationId: String(authorization._id),
      requestedAt: new Date(),
      reason: r,
    };
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await auditService.record({
      action: 'main_admin_replacement_started',
      actor,
      target: { type: 'main_admin_account', id: String(account._id) },
      tenant,
      session,
    });
    return { effect: 'replacement_started' };
  },

  async cancelReplacement(tenant, { replacementId }, actor, { session } = {}) {
    assertTenantFor(tenant, false);
    const rep = tenant.seat.replacement;
    if (!rep || rep.status !== 'pending' || (replacementId && rep.id !== replacementId)) {
      throw new AppError('invalid_main_admin_transition', 409, 'That replacement is not pending.');
    }
    const designateId = rep.designateAccountId;
    await Authorization.updateMany(
      { accountId: String(designateId), status: 'pending' },
      { $set: { status: 'withdrawn', withdrawnAt: new Date() } },
      { session },
    );
    const designate = await Account.findById(designateId).session(session || null);
    if (designate) {
      if (designate.setupCompleted) {
        throw new AppError('stale_main_admin', 409, 'The designate completed setup meanwhile.');
      }
      await tokenService.revokeAllForAccount(designate._id, 'replacement_cancelled', { session });
      // The designate account is discarded unless the person already claimed it.
      if (!designate.emailVerified && (designate.methods || []).length === 0) {
        await Account.deleteOne({ _id: designate._id }, { session });
      }
      else {
        designate.linkStatus = 'withdrawn';
        designate.linkedAuthorizationId = null;
        designate.status = 'active';
        await designate.save({ session });
      }
    }
    tenant.seat.replacement = undefined;
    tenant.seat.revision += 1;
    await tenant.save({ session });
    await auditService.record({
      action: 'main_admin_replacement_cancelled',
      actor,
      target: { type: 'main_admin_account', id: String(designateId) },
      tenant,
      session,
    });
    return { effect: 'replacement_cancelled' };
  },
};

module.exports = {
  refreshLinkState,
  normalizeDisplayName,
  completeSetup,
  provisionSeatAccount,
  seatAuthorizationFor,
  seatSnapshot,
  seatCommands,
  assertRevision,
  invitationExpiry,
};
