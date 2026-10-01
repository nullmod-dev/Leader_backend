/**
 * Customer Demo (BACKEND-HANDOFF.md §12).
 *
 * Self-service, gated only by the platform-wide policy `AppSettings.demo`.
 * A demo is an Account { role: customer_demo } + one DemoSession + one full
 * Session — never a SaasTenant, Team Code, membership or capability.
 *
 *  - Start is ATOMIC (one transaction): a failure leaves no record.
 *  - Duplicate start RESUMES (same install id → same demoSessionId and the
 *    same expiresAt), is checked BEFORE `enabled`, and authors no audit.
 *  - `expiresAt` / `policyRevision` are stamped once at creation; policy
 *    changes are not retroactive and disabling terminates nothing.
 *  - Status is decided by SERVER time: a stored `active` past `expiresAt` is
 *    `expired` (DemoSession#statusAt), and is persisted as such (once, with
 *    `customer_demo_session_expired`, actor system).
 *  - Cleanup drops EXPIRED operational rows only; terminated rows and every
 *    audit event stay.
 */
const AppError = require('../utils/appError');
const { Account, AppSettings, Counter, DemoSession, Session } = require('../models');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const tokenService = require('./tokenService');
const { withTransaction } = require('./txn');
const { ulid, sha256 } = require('../utils/ids');
const { iso } = require('../utils/time');
const cursor = require('../utils/cursor');

const DEMO_ACCOUNT_NAME = 'زائر تجريبي';
const SESSION_REVOKE_REASON = 'customer_demo_ended';

// ---- JSON ------------------------------------------------------------------------

const policyJson = (demo = {}) => {
  const out = {
    enabled: demo.enabled !== false,
    defaultDurationMinutes: demo.defaultDurationMinutes,
    maxDurationMinutes: demo.maxDurationMinutes,
    revision: demo.revision || 1,
  };
  if (demo.updatedBy && demo.updatedBy.accountId) {
    out.updatedBy = { accountId: demo.updatedBy.accountId, displayName: demo.updatedBy.displayName || '' };
  }
  if (demo.updatedAt) out.updatedAt = iso(demo.updatedAt);
  return out;
};

const sessionJson = (ds) => ds.toJSON();

const demoTarget = (ds) => ({ type: 'customer_demo_session', id: String(ds._id), displayName: ds.accountId });

const notActive = () => new AppError('demo_session_not_active', 409, 'This demo session is no longer active.');
const notFound = () => new AppError('demo_session_not_found', 404, 'demo session not found');

const installHash = (installId) => sha256(`customer-demo-install:${installId}`);

// ---- state transitions ---------------------------------------------------------------

/**
 * Persist `expired` for a stored-active session whose window has closed (by
 * server time). Idempotent: only the first caller transitions and audits.
 * @returns {boolean} whether THIS call transitioned it
 */
const expireOne = async (ds, { revoke = true, session } = {}) => {
  const now = new Date();
  const res = await DemoSession.updateOne(
    { _id: ds._id, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
    { session },
  );
  if (!res.modifiedCount) return false;
  await auditService.record({ action: 'customer_demo_session_expired', actor: null, target: demoTarget(ds), session });
  if (revoke) await tokenService.revokeAllForAccount(ds.accountId, SESSION_REVOKE_REASON, { session });
  return true;
};

/** Expire every overdue active session (job + settle-on-read). @returns count */
const expireDue = async ({ revoke = true } = {}) => {
  const due = await DemoSession.find({ status: 'active', expiresAt: { $lte: new Date() } }).limit(1000);
  let n = 0;
  for (const ds of due) {
    // eslint-disable-next-line no-await-in-loop
    const moved = await withTransaction((session) => expireOne(ds, { revoke, session }));
    if (moved) n += 1;
  }
  return n;
};

/**
 * Revoke credentials still live on demo accounts whose session is already
 * closed (a GET /session that observed expiry only marks the row).
 * @returns number of sessions revoked
 */
const revokeLeftovers = async () => {
  const accountIds = await DemoSession.distinct('accountId', { status: { $in: ['expired', 'terminated'] } });
  if (!accountIds.length) return 0;
  const res = await Session.updateMany(
    { accountId: { $in: accountIds }, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokeReason: SESSION_REVOKE_REASON } },
  );
  return res.modifiedCount || 0;
};

/**
 * Terminate one ACTIVE (by server time) session: status terminated +
 * terminationReason + endedAt, revoke the account's sessions, audit.
 * @param actor  Account doc (platform admin) or null for `system` (user_ended)
 * @returns the updated DemoSession, or null when it was not active
 */
const terminateOne = async (demoSessionId, reason, actor, { session } = {}) => {
  const now = new Date();
  const updated = await DemoSession.findOneAndUpdate(
    { _id: demoSessionId, status: 'active', expiresAt: { $gt: now } },
    { $set: { status: 'terminated', terminationReason: reason, endedAt: now } },
    { new: true, session },
  );
  if (!updated) return null;
  await tokenService.revokeAllForAccount(updated.accountId, SESSION_REVOKE_REASON, { session });
  await auditService.record({
    action: 'customer_demo_session_terminated',
    actor: actor || null,
    target: demoTarget(updated),
    changes: [{ field: 'termination_reason', after: reason }],
    session,
  });
  return updated;
};

// ---- self-service (the demo holder) ---------------------------------------------------------

/**
 * POST /auth/customer-demo/start
 * @returns {{ status: 200|201, body: { accessToken, refreshToken, demoSession } }}
 */
const start = async (req, { installId } = {}) => {
  const resumeKeyHash = installId ? installHash(installId) : null;
  await settingsService.get(); // make sure the policy singleton exists

  return withTransaction(async (session) => {
    const now = new Date();
    // The policy in force NOW (read inside the transaction, never a stale cache).
    const settings = await AppSettings.findById('global').session(session).lean();

    // 1. Resume — checked BEFORE the enabled switch; no audit, nothing re-stamped.
    if (resumeKeyHash) {
      // Serialize concurrent starts of the same install (double tap): both
      // write this lock, one transaction conflicts, retries, and resumes the
      // trial the other created.
      await Counter.next(`customer-demo-start:${resumeKeyHash}`, session);
      const running = await DemoSession.findOne({ resumeKeyHash, status: 'active', expiresAt: { $gt: now } })
        .sort({ startedAt: -1 })
        .session(session);
      if (running) {
        const account = await Account.findById(running.accountId).session(session);
        if (account && account.role === 'customer_demo' && account.status === 'active') {
          const creds = await tokenService.createSession(account, 'full', req, { session });
          return { status: 200, body: { ...tokenService.pair(creds), demoSession: sessionJson(running) } };
        }
      }
    }

    // 2. A new trial needs the policy switched on.
    const demo = (settings && settings.demo) || {};
    if (demo.enabled === false) throw new AppError('demo_unavailable', 403, 'Customer Demo is not available right now.');

    // 3. Identity + operational record + full session, all or nothing.
    const account = new Account({
      role: 'customer_demo',
      name: DEMO_ACCOUNT_NAME,
      status: 'active',
      emailVerified: false,
      setupCompleted: true,
      linkStatus: 'unlinked',
      activatedAt: now,
    });
    const demoSession = new DemoSession({
      accountId: String(account._id),
      demoWorkspaceId: `dws_${ulid()}`,
      resumeKeyHash,
      displayName: DEMO_ACCOUNT_NAME,
      startedAt: now,
      expiresAt: new Date(now.getTime() + (demo.defaultDurationMinutes || 1440) * 60000),
      status: 'active',
      policyRevision: demo.revision || 1,
    });
    account.demoSessionId = String(demoSession._id);
    await account.save({ session });
    await demoSession.save({ session });
    const creds = await tokenService.createSession(account, 'full', req, { session });
    await auditService.record({ action: 'customer_demo_session_started', actor: null, target: demoTarget(demoSession), session });
    return { status: 201, body: { ...tokenService.pair(creds), demoSession: sessionJson(demoSession) } };
  });
};

const requireDemoAccount = (account) => {
  if (!account || account.role !== 'customer_demo') throw AppError.notPermitted('Customer Demo sessions only.');
};

const loadOwnSession = async (account) => {
  requireDemoAccount(account);
  const ds = account.demoSessionId ? await DemoSession.findById(account.demoSessionId) : null;
  if (!ds) throw notFound();
  return ds;
};

/** GET /auth/customer-demo/session — marks expiry (once) but revokes nothing. */
const current = async (account) => {
  let ds = await loadOwnSession(account);
  const now = new Date();
  if (ds.status === 'active' && ds.expiresAt <= now) {
    await withTransaction((session) => expireOne(ds, { revoke: false, session }));
    ds = await DemoSession.findById(ds._id);
  }
  return { demoSession: sessionJson(ds), serverNow: now.toISOString() };
};

/** POST /auth/customer-demo/end — the holder ends their own trial. */
const endOwn = async (account) => {
  const ds = await loadOwnSession(account);
  if (ds.statusAt() !== 'active') {
    if (ds.status === 'active') await withTransaction((session) => expireOne(ds, { revoke: false, session }));
    throw notActive();
  }
  const updated = await withTransaction((session) => terminateOne(ds._id, 'user_ended', null, { session }));
  if (!updated) throw notActive();
  return { demoSession: sessionJson(updated) };
};

/** Is this demo account's trial active by server time? (gate for demo-authorized reads) */
const isActiveDemo = async (account) => {
  if (!account || account.role !== 'customer_demo' || !account.demoSessionId) return false;
  const ds = await DemoSession.findById(account.demoSessionId);
  return !!ds && ds.statusAt() === 'active';
};

// ---- platform (Super Admin) ------------------------------------------------------------------

const getPolicy = async () => policyJson((await settingsService.get()).demo);

/**
 * PATCH /platform/demo/policy. Unchanged values → no revision bump. Changes
 * are never retroactive and disabling terminates nothing.
 */
const updatePolicy = async ({ enabled, defaultDurationMinutes, expectedRevision }, actor) => {
  const settings = await settingsService.get(); // ensures the singleton exists
  const cap = settings.demo.maxDurationMinutes;
  if (defaultDurationMinutes !== undefined && defaultDurationMinutes > cap) {
    throw AppError.validation({ defaultDurationMinutes: `defaultDurationMinutes must be at most ${cap} minutes.` });
  }

  const result = await withTransaction(async (session) => {
    const doc = await AppSettings.findById('global').session(session);
    const demo = doc.demo || {};
    if (demo.revision !== expectedRevision) {
      throw new AppError('stale_demo_policy', 409, 'The demo policy changed since you last read it.', {
        currentRevision: demo.revision,
        currentPolicy: policyJson(demo),
      });
    }
    const changes = [];
    const set = {};
    if (enabled !== undefined && enabled !== demo.enabled) {
      changes.push({ field: 'demo_availability', before: demo.enabled, after: enabled });
      set['demo.enabled'] = enabled;
    }
    if (defaultDurationMinutes !== undefined && defaultDurationMinutes !== demo.defaultDurationMinutes) {
      changes.push({ field: 'demo_default_duration', before: demo.defaultDurationMinutes, after: defaultDurationMinutes });
      set['demo.defaultDurationMinutes'] = defaultDurationMinutes;
    }
    if (!changes.length) return policyJson(demo);

    const now = new Date();
    set['demo.updatedBy'] = { accountId: String(actor._id), displayName: actor.name || '' };
    set['demo.updatedAt'] = now;
    const updated = await AppSettings.findOneAndUpdate(
      { _id: 'global', 'demo.revision': expectedRevision },
      { $set: set, $inc: { 'demo.revision': 1 } },
      { new: true, session, runValidators: true },
    );
    if (!updated) throw new AppError('stale_demo_policy', 409, 'The demo policy changed since you last read it.');
    await auditService.record({
      action: 'customer_demo_policy_changed',
      actor,
      target: { type: 'customer_demo_policy', id: 'global', displayName: 'Customer Demo' },
      changes,
      session,
    });
    return policyJson(updated.demo);
  });
  settingsService.invalidate();
  return result;
};

const STATUS_ORDER = ['active', 'expired', 'terminated'];

/**
 * GET /platform/demo/sessions — active first (soonest expiresAt), then the
 * closed rows newest first. Overdue actives are settled to `expired` first so
 * stored status = status by server time.
 */
const listSessions = async ({ status, cursor: rawCursor, limit = 50 }) => {
  await expireDue();
  const c = cursor.decode(rawCursor);
  if (c && !['a', 'b'].includes(c.seg)) throw AppError.validation({ cursor: 'The cursor is not valid.' });

  const items = [];
  let next = null;
  const wantActive = !status || status === 'active';
  const closedStatuses = status ? (status === 'active' ? [] : [status]) : ['expired', 'terminated'];

  if (c && c.seg === 'a' && !wantActive) throw AppError.validation({ cursor: 'The cursor is not valid.' });

  // Segment A — active, soonest expiry first.
  if (wantActive && (!c || c.seg === 'a')) {
    const filter = { status: 'active' };
    if (c && c.seg === 'a') {
      const at = new Date(c.t);
      filter.$or = [{ expiresAt: { $gt: at } }, { expiresAt: at, _id: { $gt: c.id } }];
    }
    const rows = await DemoSession.find(filter).sort({ expiresAt: 1, _id: 1 }).limit(limit + 1);
    items.push(...rows.slice(0, limit));
    if (rows.length > limit) {
      const last = rows[limit - 1];
      next = { seg: 'a', t: last.expiresAt.toISOString(), id: String(last._id) };
    }
  }

  // Segment B — expired/terminated, newest first.
  if (!next && closedStatuses.length) {
    const room = limit - items.length;
    const filter = { status: { $in: closedStatuses } };
    if (c && c.seg === 'b' && c.t) {
      const at = new Date(c.t);
      filter.$or = [{ startedAt: { $lt: at } }, { startedAt: at, _id: { $lt: c.id } }];
    }
    if (room === 0) {
      // The page filled up exactly at the end of segment A: continue at B's start.
      if (await DemoSession.exists(filter)) next = { seg: 'b', t: null, id: null };
    } else {
      const rows = await DemoSession.find(filter).sort({ startedAt: -1, _id: -1 }).limit(room + 1);
      items.push(...rows.slice(0, room));
      if (rows.length > room) {
        const last = rows[room - 1];
        next = { seg: 'b', t: last.startedAt.toISOString(), id: String(last._id) };
      }
    }
  }

  const grouped = await DemoSession.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  grouped.forEach((g) => {
    if (counts[g._id] !== undefined) counts[g._id] = g.n;
  });

  return { items: items.map(sessionJson), counts, nextCursor: next ? cursor.encode(next) : null };
};

/** POST /platform/demo/sessions/:id/terminate */
const terminate = async (demoSessionId, actor) => {
  const ds = await DemoSession.findById(demoSessionId);
  if (!ds) throw notFound();
  if (ds.statusAt() !== 'active') {
    if (ds.status === 'active') await withTransaction((session) => expireOne(ds, { session }));
    throw notActive();
  }
  const updated = await withTransaction((session) => terminateOne(ds._id, 'super_admin_terminated', actor, { session }));
  if (!updated) throw notActive();
  return sessionJson(updated);
};

/** POST /platform/demo/sessions/terminate-all — every active session; per-session audit. */
const terminateAll = async (actor) => {
  await expireDue();
  const active = await DemoSession.find({ status: 'active', expiresAt: { $gt: new Date() } }).select('_id');
  let n = 0;
  for (const row of active) {
    // eslint-disable-next-line no-await-in-loop
    const done = await withTransaction((session) => terminateOne(row._id, 'terminate_all', actor, { session }));
    if (done) n += 1;
  }
  return { terminated: n };
};

/**
 * POST /platform/demo/sessions/cleanup — removes ONLY expired operational
 * rows. Terminated rows stay; audit is never touched.
 */
const cleanup = async () => {
  await expireDue();
  await revokeLeftovers();
  const res = await DemoSession.deleteMany({ status: 'expired' });
  return { removed: res.deletedCount || 0 };
};

module.exports = {
  DEMO_ACCOUNT_NAME,
  policyJson,
  installHash,
  expireOne,
  expireDue,
  revokeLeftovers,
  terminateOne,
  start,
  current,
  endOwn,
  isActiveDemo,
  getPolicy,
  updatePolicy,
  listSessions,
  terminate,
  terminateAll,
  cleanup,
};
