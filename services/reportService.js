/**
 * Platform Reports — Point 13A (API_CONTRACT.md → "Platform Reports").
 *
 * Four synchronous, read-only projections over the CONTROL PLANE:
 *   subscriptions · usage_limits · feature_availability · platform_activity
 *
 * Snapshot-bound cursors: the full filtered row set is computed once and kept
 * in a small in-process LRU (≤ 8 snapshots, 3 h TTL) under an opaque
 * `snapshotId`. A cursor is `{s: snapshotId, o: offset}`; pages 2…n are served
 * from that same snapshot (same rows, order and summary). A cursor whose
 * snapshot is gone answers `409 report_cursor_expired`, and the client reloads
 * page one. Snapshots live in process memory only (one API instance; behind a
 * load balancer, pin report reads or accept an occasional reload).
 *
 * Deleted tenants are never rows or buckets. Rows carry `tenant.{id,
 * displayName}` plus the report's typed fields — never a Team Code, an email,
 * a reason or any tenant operational record.
 */
const AppError = require('../utils/appError');
const cursorUtil = require('../utils/cursor');
const { newId } = require('../utils/ids');
const { iso } = require('../utils/time');
const usageService = require('./usageService');
const { ACTION_CATEGORY } = require('./auditService');
const { PLAN_LIMIT_KEYS, FEATURE_KEYS } = require('../config/constants');
const { SaasTenant, Plan, AuditEvent } = require('../models');

const SNAPSHOT_MAX = 8;
const SNAPSHOT_TTL_MS = 3 * 3600000;
const DAY_MS = 86400000;
const MAX_RANGE_MS = 367 * DAY_MS;
const DEFAULT_RANGE_MS = 30 * DAY_MS;

const REPORTABLE_LIFECYCLE = ['active', 'suspended', 'deletion_pending'];
const STATUS_ORDER = ['active', 'trial', 'grace', 'inactive'];
const BAND_ORDER = ['within_limit', 'at_limit', 'over_limit', 'no_limit'];
const BAND_SEVERITY = { over_limit: 3, at_limit: 2, within_limit: 1, no_limit: 0 };
const ACTIVITY_CATEGORIES = [
  'tenant_management',
  'subscription',
  'entitlement',
  'lifecycle',
  'emergency_access',
  'account_management',
  'customer_demo',
];

const collator = new Intl.Collator('ar', { sensitivity: 'variant', numeric: true });

// ---- snapshot store (LRU + TTL) ---------------------------------------------------------

const snapshots = new Map();

const prune = (now = Date.now()) => {
  for (const [id, snap] of snapshots) if (now - snap.createdAt > SNAPSHOT_TTL_MS) snapshots.delete(id);
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value);
};

const putSnapshot = (snap) => {
  snapshots.delete(snap.id);
  snapshots.set(snap.id, snap);
  prune();
};

const getSnapshot = (id) => {
  const snap = snapshots.get(id);
  if (!snap) return null;
  if (Date.now() - snap.createdAt > SNAPSHOT_TTL_MS) {
    snapshots.delete(id);
    return null;
  }
  // Refresh recency.
  snapshots.delete(id);
  snapshots.set(id, snap);
  return snap;
};

/** Test/ops hook: drop every snapshot (next cursor → report_cursor_expired). */
const clearSnapshots = () => snapshots.clear();
const snapshotCount = () => snapshots.size;

// ---- shared helpers ----------------------------------------------------------------------

const CURSOR_EXPIRED = () =>
  new AppError('report_cursor_expired', 409, 'This report page is no longer available. Reload the first page.');

const decodeReportCursor = (raw) => {
  const c = cursorUtil.decode(raw);
  if (!c) return null;
  if (typeof c.s !== 'string' || !c.s || !Number.isInteger(c.o) || c.o < 0) {
    throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
  }
  return c;
};

/** Canonical identity of a report's filters (cursor/limit excluded). */
const filterKey = (query) => {
  const out = {};
  Object.keys(query)
    .filter((k) => k !== 'cursor' && k !== 'limit' && query[k] !== undefined)
    .sort()
    .forEach((k) => {
      const v = query[k];
      if (Array.isArray(v)) out[k] = [...v].sort();
      else if (v instanceof Date) out[k] = v.toISOString();
      else out[k] = v;
    });
  return JSON.stringify(out);
};

const envelope = (snap, offset, limit) => {
  if (offset > snap.rows.length) throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
  const end = offset + limit;
  return {
    type: snap.type,
    generatedAt: iso(snap.generatedAt),
    snapshotId: snap.id,
    summary: snap.summary,
    rows: {
      items: snap.rows.slice(offset, end),
      nextCursor: end < snap.rows.length ? cursorUtil.encode({ s: snap.id, o: end }) : null,
    },
  };
};

/**
 * Serve page one (computing and, when it pages, storing a snapshot) or a
 * later page from the snapshot its cursor names.
 */
const snapshotReport = async (type, query, build) => {
  const limit = query.limit || 50;
  const key = filterKey(query);
  const c = decodeReportCursor(query.cursor);
  if (c) {
    const snap = getSnapshot(c.s);
    if (!snap) throw CURSOR_EXPIRED();
    if (snap.type !== type || snap.key !== key) {
      throw AppError.validation({ cursor: 'The cursor belongs to a different report or filter.' }, 'Foreign cursor.');
    }
    return envelope(snap, c.o, limit);
  }
  const { summary, rows } = await build(query);
  const snap = { id: newId('rpt'), type, key, generatedAt: new Date(), createdAt: Date.now(), summary, rows };
  if (rows.length > limit) putSnapshot(snap);
  return envelope(snap, 0, limit);
};

const loadPlans = async () => {
  const plans = await Plan.find().lean();
  return new Map(plans.map((p) => [p._id, p]));
};

/** The tenant's plan doc, or null (no plan, or a plan id with no definition). */
const planOf = (tenant, plans) => {
  const id = tenant.subscription && tenant.subscription.planId;
  return (id && plans.get(id)) || null;
};

const planRef = (plan) => (plan ? { id: plan._id, name: plan.name } : null);
const tenantRef = (t) => ({ id: String(t._id), displayName: t.displayName });

/** Reportable tenants (never deleted) matching lifecycle + plan filters. */
const reportableTenants = async (query, plans, { hydrate = false } = {}) => {
  const lifecycle = query.lifecycle && query.lifecycle.length ? query.lifecycle : REPORTABLE_LIFECYCLE;
  const q = SaasTenant.find({ 'lifecycle.status': { $in: lifecycle } }).sort({ _id: 1 });
  const tenants = hydrate ? await q : await q.lean();
  return tenants.filter((t) => {
    const plan = planOf(t, plans);
    if (query.planId) return !!plan && plan._id === query.planId;
    if (query.noPlan === true) return !plan;
    return true;
  });
};

const zeroBuckets = (keys) => keys.map((key) => ({ key, count: 0 }));
const bump = (buckets, key) => {
  let b = buckets.find((x) => x.key === key);
  if (!b) {
    b = { key, count: 0 };
    buckets.push(b);
  }
  b.count += 1;
};

// ---- subscriptions -------------------------------------------------------------------------

const relevantDateOf = (sub = {}) => {
  if (sub.status === 'trial') return sub.trialEndsAt || null;
  if (sub.status === 'active') return sub.renewsAt || null;
  if (sub.status === 'grace') return sub.graceEndsAt || null;
  return null;
};

const buildSubscriptions = async (query) => {
  const plans = await loadPlans();
  const tenants = await reportableTenants(query, plans);
  const rows = [];
  tenants.forEach((t) => {
    const sub = t.subscription || {};
    if (query.status && query.status.length && !query.status.includes(sub.status)) return;
    const relevantDate = relevantDateOf(sub);
    if (query.dueBefore && !(relevantDate && relevantDate < query.dueBefore)) return;
    rows.push({
      tenant: tenantRef(t),
      lifecycle: t.lifecycle.status,
      subscriptionStatus: sub.status,
      plan: planRef(planOf(t, plans)),
      relevantDate: relevantDate ? iso(relevantDate) : null,
    });
  });

  rows.sort((a, b) => {
    if (a.relevantDate !== b.relevantDate) {
      if (!a.relevantDate) return 1;
      if (!b.relevantDate) return -1;
      return a.relevantDate < b.relevantDate ? -1 : 1;
    }
    return a.tenant.id < b.tenant.id ? -1 : a.tenant.id > b.tenant.id ? 1 : 0;
  });

  const byStatus = zeroBuckets(STATUS_ORDER);
  const byLifecycle = zeroBuckets(REPORTABLE_LIFECYCLE);
  const planCounts = new Map();
  let noPlan = 0;
  rows.forEach((r) => {
    bump(byStatus, r.subscriptionStatus);
    bump(byLifecycle, r.lifecycle);
    if (r.plan) {
      const entry = planCounts.get(r.plan.id) || { plan: r.plan, count: 0 };
      entry.count += 1;
      planCounts.set(r.plan.id, entry);
    } else noPlan += 1;
  });
  const byPlan = [...planCounts.values()].sort((a, b) => b.count - a.count || (a.plan.id < b.plan.id ? -1 : 1));
  if (noPlan > 0) byPlan.push({ plan: null, count: noPlan });

  return { summary: { tenantCount: rows.length, byStatus, byLifecycle, byPlan }, rows };
};

// ---- usage-limits ----------------------------------------------------------------------------

const bandOf = (usage, limit) => {
  if (limit === null || limit === undefined) return 'no_limit';
  if (usage > limit) return 'over_limit';
  if (usage === limit) return 'at_limit';
  return 'within_limit';
};

/** usage/limit; null without a limit; a zero limit is 1 at zero usage, ∞ above. */
const ratioOf = (usage, limit) => {
  if (limit === null || limit === undefined) return null;
  if (limit === 0) return usage === 0 ? 1 : Infinity;
  return usage / limit;
};

const worstBand = (cells) => cells.reduce((w, c) => (BAND_SEVERITY[c.band] > BAND_SEVERITY[w] ? c.band : w), 'no_limit');
const bestRatio = (cells) =>
  cells.reduce((best, c) => (c.ratio !== null && (best === null || c.ratio > best) ? c.ratio : best), null);

/** Usage for many tenants, a few at a time (bounded DB concurrency). */
const usageFor = async (tenants, chunk = 10) => {
  const out = new Map();
  for (let i = 0; i < tenants.length; i += chunk) {
    const slice = tenants.slice(i, i + chunk);
    // eslint-disable-next-line no-await-in-loop
    const usages = await Promise.all(slice.map((t) => usageService.computeUsage(t)));
    slice.forEach((t, j) => out.set(String(t._id), usages[j]));
  }
  return out;
};

const buildUsageLimits = async (query) => {
  const plans = await loadPlans();
  const tenants = await reportableTenants(query, plans);
  const usages = await usageFor(tenants);

  const enriched = tenants.map((t) => {
    const plan = planOf(t, plans);
    const overrides = usageService.overridesOf(t);
    const effective = usageService.effectiveLimits(t, plan);
    const usage = usages.get(String(t._id));
    const cells = PLAN_LIMIT_KEYS.map((key) => {
      const limit = plan ? effective[key] : null;
      const u = usage[key] || 0;
      return {
        key,
        usage: u,
        limit,
        overridden: !!plan && overrides[key] !== undefined && overrides[key] !== null,
        band: bandOf(u, limit),
        ratio: ratioOf(u, limit),
      };
    });
    const focus = query.limitKey ? cells.filter((c) => c.key === query.limitKey) : cells;
    return {
      tenant: tenantRef(t),
      lifecycle: t.lifecycle.status,
      plan: planRef(plan),
      cells,
      rankBand: worstBand(focus),
      rankRatio: bestRatio(focus),
    };
  });

  const filtered = query.band && query.band.length ? enriched.filter((r) => query.band.includes(r.rankBand)) : enriched;

  filtered.sort((a, b) => {
    const sev = BAND_SEVERITY[b.rankBand] - BAND_SEVERITY[a.rankBand];
    if (sev !== 0) return sev;
    if (a.rankRatio !== b.rankRatio) {
      if (a.rankRatio === null) return 1;
      if (b.rankRatio === null) return -1;
      return b.rankRatio - a.rankRatio;
    }
    return a.tenant.id < b.tenant.id ? -1 : a.tenant.id > b.tenant.id ? 1 : 0;
  });

  const byKey = PLAN_LIMIT_KEYS.map((key) => ({ key, bands: zeroBuckets(BAND_ORDER) }));
  filtered.forEach((r) =>
    r.cells.forEach((c) => {
      bump(byKey.find((k) => k.key === c.key).bands, c.band);
    }),
  );

  const rows = filtered.map((r) => ({
    tenant: r.tenant,
    lifecycle: r.lifecycle,
    plan: r.plan,
    cells: r.cells.map((c) => ({ key: c.key, usage: c.usage, limit: c.limit, overridden: c.overridden })),
  }));
  return { summary: { tenantCount: rows.length, byKey }, rows };
};

// ---- feature-availability ------------------------------------------------------------------------

const featureStateOf = (tenant, key) => {
  const row = (tenant.features || []).find((f) => f.key === key);
  if (!row || typeof row.enabled !== 'boolean') return 'unsupported';
  return row.enabled ? 'enabled' : 'disabled';
};

const buildFeatureAvailability = async (query) => {
  const plans = await loadPlans();
  const tenants = await reportableTenants(query, plans);
  const rows = [];
  tenants.forEach((t) => {
    const features = FEATURE_KEYS.map((key) => ({ key, state: featureStateOf(t, key) }));
    if (query.featureKey && query.state) {
      const cell = features.find((f) => f.key === query.featureKey);
      if (cell.state !== query.state) return;
    }
    rows.push({ tenant: tenantRef(t), lifecycle: t.lifecycle.status, features });
  });

  rows.sort((a, b) => collator.compare(a.tenant.displayName, b.tenant.displayName) || (a.tenant.id < b.tenant.id ? -1 : a.tenant.id > b.tenant.id ? 1 : 0));

  const byFeature = FEATURE_KEYS.map((key) => ({ key, states: zeroBuckets(['enabled', 'disabled']) }));
  rows.forEach((r) =>
    r.features.forEach((f) => {
      bump(byFeature.find((x) => x.key === f.key).states, f.state);
    }),
  );
  return { summary: { tenantCount: rows.length, byFeature }, rows };
};

// ---- platform-activity --------------------------------------------------------------------------------

const RANGE_TOO_LARGE = () =>
  new AppError('report_range_too_large', 422, 'The range may span at most 367 days.', { maxRangeDays: 367 });

/** Resolve [from, before): default last 30 days; before-from ≤ 367 × 24 h. */
const resolveActivityRange = (query, now = new Date()) => {
  const before = query.before || now;
  const from = query.from || new Date(before.getTime() - DEFAULT_RANGE_MS);
  if (from >= before) throw AppError.validation({ before: 'before must be later than from.' });
  if (before.getTime() - from.getTime() > MAX_RANGE_MS) throw RANGE_TOO_LARGE();
  return { from, before };
};

const platformActivity = async (query, now = new Date()) => {
  const { from, before } = resolveActivityRange(query, now);
  const categories = query.category ? [query.category] : ACTIVITY_CATEGORIES;
  const match = { stream: 'platform', occurredAt: { $gte: from, $lt: before } };
  if (query.category) match.category = query.category;
  const seen = await AuditEvent.aggregate([{ $match: match }, { $group: { _id: '$action', count: { $sum: 1 } } }]);
  const counts = new Map(seen.map((s) => [s._id, s.count]));

  const catalogue = Object.keys(ACTION_CATEGORY).filter((a) => categories.includes(ACTION_CATEGORY[a]));
  const byAction = catalogue.map((key) => ({ key, count: counts.get(key) || 0 }));
  [...counts.keys()]
    .filter((k) => !catalogue.includes(k))
    .sort()
    .forEach((key) => byAction.push({ key, count: counts.get(key) }));

  return {
    type: 'platform_activity',
    generatedAt: iso(now),
    snapshotId: newId('rpt'),
    range: { from: iso(from), before: iso(before) },
    evidenceAvailableFrom: null,
    byAction,
  };
};

// ---- public API ------------------------------------------------------------------------------------------

const subscriptions = (query) => snapshotReport('subscriptions', query, buildSubscriptions);
const usageLimits = (query) => snapshotReport('usage_limits', query, buildUsageLimits);
const featureAvailability = (query) => snapshotReport('feature_availability', query, buildFeatureAvailability);

module.exports = {
  subscriptions,
  usageLimits,
  featureAvailability,
  platformActivity,
  resolveActivityRange,
  clearSnapshots,
  snapshotCount,
  SNAPSHOT_MAX,
  SNAPSHOT_TTL_MS,
  ACTIVITY_CATEGORIES,
};
