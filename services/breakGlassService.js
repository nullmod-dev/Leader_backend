/**
 * Break-glass emergency access (API_CONTRACT.md → "Break-glass emergency
 * access — Point 12").
 *
 * A grant is exceptional, temporary, single-tenant, READ-ONLY access bound to
 * ONE Super Admin session. Never a role, a Cap, impersonation, or a lifecycle
 * bypass. At most one possibly-live grant per session.
 *
 * State machine: active → ended (initiator / session ended / tenant
 * unavailable / platform revocation) · active → expired (server time).
 * Terminal. `revision` +1 on every state change.
 *
 * Every transition is ONE atomic conditional update (`status: 'active'`) plus
 * its audit event in the same transaction, so a concurrent settle (job,
 * read, command) can never double-transition or double-audit.
 */
const AppError = require('../utils/appError');
const { BreakGlassGrant, SaasTenant, TenantTombstone, Session, Detachment, DetachmentGroup, TeamMember, Shift, InventoryItem, Workshop } = require('../models');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const serializers = require('./serializers');
const rollups = require('./rollups');
const { withTransaction } = require('./txn');
const { BREAK_GLASS_SCOPES, BREAK_GLASS_STATUS, REASON_MAX } = require('../config/constants');
const { reason: normalizeReason } = require('../utils/normalize');
const { iso, parseDay, todayIn, weekStartOf, addDays, diffDays } = require('../utils/time');
const cursor = require('../utils/cursor');

const OPERATIONAL_READ = 'tenant_operational_read';

// ---- JSON --------------------------------------------------------------------------

/** The grant resource. Never carries sessionId, tokens, device or tenant secrets. */
const serialize = (g) => {
  if (!g) return null;
  const out = {
    id: String(g._id),
    revision: g.revision,
    tenant: { tenantId: g.tenant.tenantId, displayName: g.tenant.displayName || '' },
    scopes: [...(g.scopes || [])],
    reason: g.reason,
    initiator: { accountId: (g.initiator && g.initiator.accountId) || '', displayName: (g.initiator && g.initiator.displayName) || '' },
    issuedAt: iso(g.issuedAt),
    expiresAt: iso(g.expiresAt),
    status: g.status,
  };
  if (g.status === 'ended') {
    out.endedAt = iso(g.endedAt);
    out.endReason = g.endReason;
  }
  return out;
};

const tenantRefOf = (g) => ({ id: g.tenant.tenantId, displayName: g.tenant.displayName || '' });

const END_AUDIT = {
  ended_by_initiator: 'break_glass_ended',
  revoked_by_platform: 'break_glass_revoked',
  session_ended: 'break_glass_revoked',
  tenant_unavailable: 'break_glass_revoked',
};

const notFound = () => new AppError('break_glass_not_found', 404, 'break-glass grant not found');
const notActive = (g) => new AppError('break_glass_not_active', 409, 'This grant is no longer active.', { grant: serialize(g) });
const stale = (g) =>
  new AppError('stale_break_glass', 409, 'The grant changed since you last read it.', { currentRevision: g.revision, currentRecord: serialize(g) });

// ---- transitions ---------------------------------------------------------------------

/**
 * Move an ACTIVE grant to `expired` or `ended` + audit, atomically.
 * @param opts.actor            Account doc, or null for `system`
 * @param opts.expectedRevision optional revision guard
 * @returns the updated grant, or null when it was no longer active (or the revision moved)
 */
const transition = async (grantId, { status, endReason, actor = null, expectedRevision }, { session } = {}) => {
  const now = new Date();
  const filter = { _id: grantId, status: 'active' };
  if (expectedRevision !== undefined) filter.revision = expectedRevision;
  if (status === 'expired') filter.expiresAt = { $lte: now };
  const set = { status };
  if (status === 'ended') {
    set.endedAt = now;
    set.endReason = endReason;
  }
  const updated = await BreakGlassGrant.findOneAndUpdate(filter, { $set: set, $inc: { revision: 1 } }, { new: true, session });
  if (!updated) return null;
  await auditService.record({
    action: status === 'expired' ? 'break_glass_expired' : END_AUDIT[endReason],
    actor,
    target: { type: 'break_glass_grant', id: String(updated._id) },
    tenant: tenantRefOf(updated),
    grantId: String(updated._id),
    session,
  });
  return updated;
};

const runTransition = (grantId, opts) => withTransaction((session) => transition(grantId, opts, { session }));

const tenantIsActive = (tenant) => !!tenant && tenant.lifecycle && tenant.lifecycle.status === 'active';

/**
 * Settle one grant on read: past expiry → expired; target no longer active →
 * ended tenant_unavailable. Returns the fresh grant.
 */
const settle = async (grant, { checkTenant = true } = {}) => {
  if (!grant || grant.status !== 'active') return grant;
  if (grant.expiresAt <= new Date()) {
    await runTransition(grant._id, { status: 'expired' });
    return BreakGlassGrant.findById(grant._id);
  }
  if (checkTenant) {
    const tenant = await SaasTenant.findById(grant.tenant.tenantId).select('lifecycle');
    if (!tenantIsActive(tenant)) {
      await runTransition(grant._id, { status: 'ended', endReason: 'tenant_unavailable' });
      return BreakGlassGrant.findById(grant._id);
    }
  }
  return grant;
};

/** Expire every active grant past expiresAt (job + settle-before-list). @returns count */
const expireDue = async () => {
  const due = await BreakGlassGrant.find({ status: 'active', expiresAt: { $lte: new Date() } }).select('_id').limit(1000);
  let n = 0;
  for (const g of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await runTransition(g._id, { status: 'expired' })) n += 1;
  }
  return n;
};

/**
 * Job body: expiry, then bound-session end, then target lifecycle.
 * @returns number of grants moved
 */
const settleAll = async () => {
  let n = await expireDue();
  const active = await BreakGlassGrant.find({ status: 'active' });
  if (!active.length) return n;
  const [sessions, tenants] = await Promise.all([
    Session.find({ _id: { $in: [...new Set(active.map((g) => g.sessionId))] } }),
    SaasTenant.find({ _id: { $in: [...new Set(active.map((g) => g.tenant.tenantId))] } }).select('lifecycle'),
  ]);
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
  const tenantById = new Map(tenants.map((t) => [String(t._id), t]));
  for (const g of active) {
    const s = sessionById.get(g.sessionId);
    let endReason = null;
    if (!s || !s.isLive()) endReason = 'session_ended';
    else if (!tenantIsActive(tenantById.get(g.tenant.tenantId))) endReason = 'tenant_unavailable';
    // eslint-disable-next-line no-await-in-loop
    if (endReason && (await runTransition(g._id, { status: 'ended', endReason }))) n += 1;
  }
  return n;
};

// ---- commands & reads ---------------------------------------------------------------------

/** GET /current — the possibly-live grant of THIS session, else its latest terminal one. */
const current = async (session) => {
  const sessionId = String(session._id);
  const live = await BreakGlassGrant.find({ sessionId, status: 'active' }).sort({ issuedAt: -1, _id: -1 });
  for (const g of live) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await settle(g);
    if (fresh && fresh.status === 'active') return fresh;
  }
  return BreakGlassGrant.findOne({ sessionId }).sort({ issuedAt: -1, _id: -1 });
};

/**
 * POST /grants. Refusal order (each a distinct code):
 * reason → scope → recent auth → tombstone → unknown → lifecycle → version → already active.
 */
const activate = async ({ account, session: authSession }, { tenantId, expectedTenantVersion, scopes, reason }) => {
  const cleanReason = typeof reason === 'string' ? normalizeReason(reason, REASON_MAX) : null;
  if (!cleanReason) {
    throw new AppError('invalid_break_glass_reason', 422, `A reason of 1–${REASON_MAX} characters is required.`);
  }
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => typeof s === 'string' && BREAK_GLASS_SCOPES.includes(s))) {
    throw new AppError('invalid_break_glass_scope', 422, `scopes must be a non-empty subset of: ${BREAK_GLASS_SCOPES.join(', ')}.`);
  }
  const settings = await settingsService.get();
  const now = new Date();
  const freshSince = new Date(now.getTime() - settings.recentAuthMinutes * 60000);
  if (!authSession.authenticatedAt || new Date(authSession.authenticatedAt) < freshSince) {
    throw new AppError('recent_authentication_required', 403, 'Sign in again to activate emergency access.', {
      recentAuthMinutes: settings.recentAuthMinutes,
    });
  }

  const created = await withTransaction(async (session) => {
    if (await TenantTombstone.exists({ _id: tenantId }).session(session)) {
      throw new AppError('tenant_already_deleted', 409, 'This team has been deleted.');
    }
    const tenant = await SaasTenant.findById(tenantId).session(session);
    if (!tenant) throw new AppError('tenant_not_found', 404, 'tenant not found');
    if (tenant.lifecycle.status === 'deleted') throw new AppError('tenant_already_deleted', 409, 'This team has been deleted.');
    if (tenant.lifecycle.status !== 'active') {
      throw new AppError('tenant_not_eligible', 409, 'Only an active team can be the target of emergency access.', {
        tenantStatus: tenant.lifecycle.status,
      });
    }
    if (tenant.lifecycle.version !== expectedTenantVersion) {
      throw new AppError('stale_tenant', 409, 'The team changed since you last read it.', { currentVersion: tenant.lifecycle.version });
    }

    // Serialize concurrent activations of the same session (write conflict → retry sees the winner).
    await Session.updateOne({ _id: authSession._id }, { $set: { lastUsedAt: now } }, { session });

    const existing = await BreakGlassGrant.find({ sessionId: String(authSession._id), status: 'active' }).session(session);
    for (const g of existing) {
      if (g.expiresAt <= now) {
        // eslint-disable-next-line no-await-in-loop
        await transition(g._id, { status: 'expired' }, { session });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const target = await SaasTenant.findById(g.tenant.tenantId).select('lifecycle').session(session);
        if (tenantIsActive(target)) {
          throw new AppError('break_glass_already_active', 409, 'This session already holds a live grant.', { grant: serialize(g) });
        }
        // eslint-disable-next-line no-await-in-loop
        await transition(g._id, { status: 'ended', endReason: 'tenant_unavailable' }, { session });
      }
    }

    const [grant] = await BreakGlassGrant.create(
      [
        {
          sessionId: String(authSession._id),
          revision: 1,
          tenant: { tenantId: String(tenant._id), displayName: tenant.displayName },
          scopes: [...new Set(scopes)],
          reason: cleanReason,
          initiator: { accountId: String(account._id), displayName: account.name || '' },
          issuedAt: now,
          expiresAt: new Date(now.getTime() + settings.breakGlassMinutes * 60000),
          status: 'active',
        },
      ],
      { session },
    );
    await auditService.record({
      action: 'break_glass_activated',
      actor: account,
      target: { type: 'break_glass_grant', id: String(grant._id) },
      tenant: { id: String(tenant._id), displayName: tenant.displayName },
      grantId: String(grant._id),
      session,
    });
    return grant;
  });
  return created;
};

/** Shared end/revoke: settle → not active → stale → transition. */
const endWith = async (grant, { expectedRevision, endReason, actor }) => {
  const fresh = await settle(grant, { checkTenant: false });
  if (fresh.status !== 'active') throw notActive(fresh);
  if (fresh.revision !== expectedRevision) throw stale(fresh);
  const updated = await runTransition(fresh._id, { status: 'ended', endReason, actor, expectedRevision });
  if (updated) return updated;
  const now = await BreakGlassGrant.findById(fresh._id);
  if (now.status !== 'active') throw notActive(now);
  throw stale(now);
};

/** POST /grants/:grantId/end — the initiator's own session only. */
const end = async ({ account, session }, grantId, expectedRevision) => {
  const grant = await BreakGlassGrant.findById(grantId);
  if (!grant || grant.sessionId !== String(session._id)) throw notFound();
  return endWith(grant, { expectedRevision, endReason: 'ended_by_initiator', actor: account });
};

/** POST /grants/:grantId/revoke — any Super Admin. */
const revoke = async ({ account }, grantId, expectedRevision) => {
  const grant = await BreakGlassGrant.findById(grantId);
  if (!grant) throw notFound();
  return endWith(grant, { expectedRevision, endReason: 'revoked_by_platform', actor: account });
};

/** GET /grants — every grant, newest first (management view). */
const list = async ({ status, cursor: rawCursor, limit = 50 }) => {
  await expireDue();
  const filter = {};
  if (status) {
    if (!BREAK_GLASS_STATUS.includes(status)) throw AppError.validation({ status: 'Unknown status.' });
    filter.status = status;
  }
  const c = cursor.decode(rawCursor);
  if (c) {
    const at = new Date(c.t);
    filter.$or = [{ issuedAt: { $lt: at } }, { issuedAt: at, _id: { $lt: c.id } }];
  }
  const rows = await BreakGlassGrant.find(filter).sort({ issuedAt: -1, _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(serialize),
    nextCursor: rows.length > limit && last ? cursor.encode({ t: last.issuedAt.toISOString(), id: String(last._id) }) : null,
  };
};

// ---- grant-scoped read-only viewer ------------------------------------------------------------

const VIEW_RESOURCES = ['detachment-groups', 'detachments', 'members', 'shifts', 'inventory-items', 'workshops'];
const RESOURCE_FEATURE = { 'inventory-items': 'inventory', workshops: 'workshops' };
const MAX_SHIFT_RANGE_DAYS = 31;

/**
 * Authorize a grant-scoped read (contract precedence 4 → 8): live grant bound
 * to THIS session → scope → target lifecycle re-checked per request (not
 * active → the grant ends `tenant_unavailable` and the read is refused) →
 * feature flag.
 */
const authorizeRead = async (authSession, resource) => {
  const sessionId = String(authSession._id);
  const candidates = await BreakGlassGrant.find({ sessionId, status: 'active' }).sort({ issuedAt: -1, _id: -1 });
  let grant = null;
  for (const g of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await settle(g, { checkTenant: false });
    if (fresh && fresh.status === 'active') {
      grant = fresh;
      break;
    }
  }
  if (!grant) throw AppError.notPermitted('No live break-glass grant is bound to this session.');
  if (!(grant.scopes || []).includes(OPERATIONAL_READ)) throw AppError.notPermitted('The grant carries no operational read scope.');

  const tenant = await SaasTenant.findById(grant.tenant.tenantId);
  if (!tenantIsActive(tenant)) {
    await runTransition(grant._id, { status: 'ended', endReason: 'tenant_unavailable' });
    throw new AppError('tenant_unavailable', 403, 'The team is not active.', {
      tenantStatus: tenant ? tenant.lifecycle.status : 'deleted',
    });
  }
  const feature = RESOURCE_FEATURE[resource];
  if (feature && !tenant.featureEnabled(feature)) {
    throw new AppError('feature_disabled', 403, `The ${feature} module is not enabled for this team.`, { feature });
  }
  return { grant, tenant };
};

const assertDetachment = async (tenantId, detachmentId) => {
  if (!detachmentId) return;
  if (!(await Detachment.exists({ _id: detachmentId, tenantId }))) throw AppError.notFound('detachment');
};

const shiftRange = (query, tz) => {
  const hasFrom = query.from !== undefined && query.from !== '';
  const hasTo = query.to !== undefined && query.to !== '';
  if (!hasFrom && !hasTo) {
    const from = weekStartOf(todayIn(tz));
    return { from, to: addDays(from, 6) };
  }
  const fields = {};
  const from = hasFrom ? parseDay(query.from) : null;
  const to = hasTo ? parseDay(query.to) : null;
  if (!from) fields.from = 'from must be a YYYY-MM-DD day.';
  if (!to) fields.to = 'to must be a YYYY-MM-DD day.';
  if (Object.keys(fields).length) throw AppError.validation(fields);
  if (to < from) throw AppError.validation({ to: 'to must not be before from.' });
  if (diffDays(from, to) + 1 > MAX_SHIFT_RANGE_DAYS) {
    throw AppError.validation({ to: `The range may cover at most ${MAX_SHIFT_RANGE_DAYS} days.` });
  }
  return { from, to };
};

/**
 * GET /view/:resource → { grantId, tenant, items }. Read-only; phone numbers
 * never leave (members are serialized with NO capability grant).
 */
const view = async (authSession, resource, query = {}) => {
  if (!VIEW_RESOURCES.includes(resource)) throw AppError.notFound('resource');
  const { grant, tenant } = await authorizeRead(authSession, resource);
  const tenantId = String(tenant._id);
  const tz = tenant.timezone || 'Asia/Damascus';
  const detachmentId = query.detachmentId || undefined;
  let items = [];

  switch (resource) {
    case 'detachment-groups': {
      const groups = await DetachmentGroup.find({ tenantId }).sort({ createdAt: 1, _id: 1 });
      const roll = await rollups.groupRollups(tenantId, groups.map((g) => String(g._id)), tz);
      items = groups.map((g) => serializers.detachmentGroup(g, roll.get(String(g._id))));
      break;
    }
    case 'detachments': {
      const dets = await Detachment.find({ tenantId }).sort({ createdAt: 1, _id: 1 });
      const roll = await rollups.detachmentRollups(tenantId, dets.map((d) => String(d._id)), tz);
      items = dets.map((d) => serializers.detachment(d, roll.get(String(d._id))));
      break;
    }
    case 'members': {
      await assertDetachment(tenantId, detachmentId);
      const filter = { tenantId };
      if (detachmentId) filter.detachmentId = detachmentId;
      const members = await TeamMember.find(filter).sort({ nameKey: 1, _id: 1 });
      items = members.map((m) => serializers.member(m)); // no grant → never a phone
      break;
    }
    case 'shifts': {
      await assertDetachment(tenantId, detachmentId);
      const { from, to } = shiftRange(query, tz);
      const filter = { tenantId, date: { $gte: from, $lte: to } };
      if (detachmentId) filter.detachmentId = detachmentId;
      const list = await Shift.find(filter).sort({ date: 1, startMinutes: 1, _id: 1 });
      items = await serializers.shifts(tenantId, list, {});
      break;
    }
    case 'inventory-items': {
      await assertDetachment(tenantId, detachmentId);
      const filter = { tenantId };
      if (detachmentId) filter.detachmentId = detachmentId;
      const list = await InventoryItem.find(filter).sort({ name: 1, _id: 1 });
      items = list.map(serializers.inventoryItem);
      break;
    }
    case 'workshops': {
      const list = await Workshop.find({ tenantId }).sort({ at: -1, _id: -1 });
      items = await serializers.workshops(tenantId, list, {});
      break;
    }
    default:
      throw AppError.notFound('resource');
  }

  return { grantId: String(grant._id), tenant: { tenantId, displayName: tenant.displayName }, items };
};

module.exports = {
  VIEW_RESOURCES,
  serialize,
  transition,
  settle,
  expireDue,
  settleAll,
  current,
  activate,
  end,
  revoke,
  list,
  view,
};
