/**
 * Super Admin dashboard analytics (charts + KPI tiles) — control-plane
 * aggregates only. Every number is a COUNT or a SUM over platform
 * collections; no tenant operational record (names, attendance, stock,
 * medical data) ever leaves here. Metric definitions live in
 * docs/api/platform-insights.md and must stay in sync with this file.
 *
 * Ranges are half-open instants [from, before). Time buckets are UTC calendar
 * buckets; weeks start on SATURDAY (the product week, utils/time.weekStartOf).
 */
const AppError = require('../utils/appError');
const { iso } = require('../utils/time');
const usageService = require('./usageService');
const { SUBSCRIPTION_STATUS, FEATURE_KEYS, CURRENCY } = require('../config/constants');
const {
  SaasTenant,
  Account,
  Session,
  DemoSession,
  BillingOrder,
  Plan,
  DetachmentGroup,
  Detachment,
  TeamMember,
  Workshop,
  Announcement,
  TenantStatusEvent,
} = require('../models');

const DAY = 86400000;
const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const MAX_BUCKETS = 400;
const NOT_DELETED = { 'lifecycle.status': { $ne: 'deleted' } };
const LIFECYCLE_KEYS = ['active', 'suspended', 'deletion_pending'];
const TENANT_ADMIN = { role: { $in: ['main_admin', 'admin'] }, status: { $ne: 'revoked' } };

// ---- ranges & buckets ---------------------------------------------------------------------

/**
 * [from, before): explicit bounds win; otherwise `period` (or `defaultMs`)
 * back from `before` (default now). from ≥ before → 422 validation.
 */
const resolveRange = (q = {}, now = new Date(), defaultMs = 30 * DAY) => {
  const before = q.before || now;
  const span = q.period ? PERIOD_DAYS[q.period] * DAY : defaultMs;
  const from = q.from || new Date(before.getTime() - span);
  if (from >= before) throw AppError.validation({ before: 'before must be later than from.' });
  return { from, before };
};

const dayKey = (date) => date.toISOString().slice(0, 10);

/** Start (YYYY-MM-DD, UTC) of the bucket containing `day`. */
const bucketOf = (day, granularity) => {
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  if (granularity === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    const offset = (d.getUTCDay() + 1) % 7; // Sat → 0 … Fri → 6
    return dayKey(new Date(d.getTime() - offset * DAY));
  }
  return day;
};

const nextBucket = (key, granularity) => {
  const d = new Date(`${key}T00:00:00Z`);
  if (granularity === 'month') return dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  return dayKey(new Date(d.getTime() + (granularity === 'week' ? 7 : 1) * DAY));
};

/** Every bucket start overlapping [from, before); > 400 → 422 validation. */
const bucketsFor = (from, before, granularity) => {
  const last = bucketOf(dayKey(new Date(before.getTime() - 1)), granularity);
  const out = [];
  for (let key = bucketOf(dayKey(from), granularity); key <= last; key = nextBucket(key, granularity)) {
    out.push(key);
    if (out.length > MAX_BUCKETS) {
      throw AppError.validation({ granularity: `The range holds more than ${MAX_BUCKETS} ${granularity} buckets.` });
    }
  }
  return out;
};

/** [{ _id: 'YYYY-MM-DD', count, total }] of `Model` docs whose `field` is in range. */
const daily = (Model, match, field, range, sumExpr = 0) =>
  Model.aggregate([
    { $match: { ...match, [field]: { $gte: range.from, $lt: range.before } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: 'UTC' } },
        count: { $sum: 1 },
        total: { $sum: sumExpr },
      },
    },
  ]);

const first = (rows, field = 'n') => (rows && rows[0] ? rows[0][field] : 0);
const countOf = (rows, key) => (rows.find((r) => r._id === key) || {}).count || 0;

/** { tenantId → count } for `match`, grouped by `groupField`. */
const groupCount = async (Model, match, groupField) => {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: `$${groupField}`, count: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.count]));
};

// ---- summary --------------------------------------------------------------------------------------

const summary = async (q, now = new Date()) => {
  const range = resolveRange(q, now);
  const inRange = { $gte: range.from, $lt: range.before };

  const [[t], newTenants, [acc], signIns, demosStarted, demosActive, revenue, plans] = await Promise.all([
    SaasTenant.aggregate([
      { $match: NOT_DELETED },
      {
        $facet: {
          total: [{ $count: 'n' }],
          active: [{ $match: { 'usage.lastActivityAt': inRange } }, { $count: 'n' }],
          lifecycle: [{ $group: { _id: '$lifecycle.status', count: { $sum: 1 } } }],
          subscription: [{ $group: { _id: '$subscription.status', count: { $sum: 1 } } }],
          plans: [{ $group: { _id: { $ifNull: ['$subscription.planId', null] }, count: { $sum: 1 } } }],
          features: [
            { $unwind: '$features' },
            { $match: { 'features.enabled': true } },
            { $group: { _id: '$features.key', count: { $sum: 1 } } },
          ],
          storage: [{ $group: { _id: null, n: { $sum: { $ifNull: ['$usage.storageUsedBytes', 0] } } } }],
        },
      },
    ]),
    SaasTenant.countDocuments({ createdAt: inRange }),
    Account.aggregate([
      { $match: { role: { $ne: 'customer_demo' } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          tenantAdmins: [{ $match: TENANT_ADMIN }, { $count: 'n' }],
          superAdmins: [{ $match: { role: 'super_admin', status: { $ne: 'revoked' } } }, { $count: 'n' }],
          newInRange: [{ $match: { createdAt: inRange } }, { $count: 'n' }],
        },
      },
    ]),
    Session.countDocuments({ scope: 'full', createdAt: inRange }),
    DemoSession.countDocuments({ startedAt: inRange }),
    DemoSession.countDocuments({ status: 'active', expiresAt: { $gt: now } }),
    BillingOrder.aggregate([
      { $match: { status: 'paid', paidAt: inRange, 'finalPrice.currency': CURRENCY } },
      { $group: { _id: null, n: { $sum: '$finalPrice.amount' } } },
    ]),
    Plan.find().sort({ order: 1, _id: 1 }).lean(),
  ]);

  const total = first(t.total);
  const planCounts = new Map(t.plans.map((p) => [p._id, p.count]));
  const plansDist = plans.map((p) => ({ planId: p._id, name: p.name, count: planCounts.get(p._id) || 0 }));
  [...planCounts.keys()]
    .filter((id) => id !== null && !plans.some((p) => p._id === id))
    .sort()
    .forEach((id) => plansDist.push({ planId: id, name: id, count: planCounts.get(id) }));
  plansDist.push({ planId: null, name: null, count: planCounts.get(null) || 0 });

  const enabled = new Map(t.features.map((f) => [f._id, f.count]));

  return {
    range: { from: iso(range.from), before: iso(range.before) },
    kpis: {
      tenants: { total, newInRange: newTenants, active: first(t.active) },
      subscriptions: Object.fromEntries(SUBSCRIPTION_STATUS.map((s) => [s, countOf(t.subscription, s)])),
      accounts: {
        total: first(acc.total),
        tenantAdmins: first(acc.tenantAdmins),
        superAdmins: first(acc.superAdmins),
        newInRange: first(acc.newInRange),
      },
      signIns,
      demos: { startedInRange: demosStarted, active: demosActive },
      revenue: { amount: first(revenue), currency: CURRENCY },
      storageUsedBytes: first(t.storage),
    },
    distributions: {
      lifecycle: LIFECYCLE_KEYS.map((key) => ({ key, count: countOf(t.lifecycle, key) })),
      subscriptionStatus: SUBSCRIPTION_STATUS.map((key) => ({ key, count: countOf(t.subscription, key) })),
      plans: plansDist,
      features: FEATURE_KEYS.map((key) => {
        const on = enabled.get(key) || 0;
        return { key, enabled: on, disabled: total - on };
      }),
    },
    generatedAt: iso(now),
  };
};

// ---- growth ---------------------------------------------------------------------------------------------

const DEFAULT_GROWTH_MS = { day: 30 * DAY, week: 84 * DAY, month: 365 * DAY };

const growth = async (q, now = new Date()) => {
  const granularity = q.granularity || 'day';
  const range = resolveRange(q, now, DEFAULT_GROWTH_MS[granularity]);
  const buckets = bucketsFor(range.from, range.before, granularity);

  const [tenants, accounts, signIns, demos, revenue] = await Promise.all([
    daily(SaasTenant, {}, 'createdAt', range),
    daily(Account, { role: { $ne: 'customer_demo' } }, 'createdAt', range),
    daily(Session, { scope: 'full' }, 'createdAt', range),
    daily(DemoSession, {}, 'startedAt', range),
    daily(BillingOrder, { status: 'paid', 'finalPrice.currency': CURRENCY }, 'paidAt', range, '$finalPrice.amount'),
  ]);

  const series = new Map(
    buckets.map((bucket) => [bucket, { bucket, tenantsCreated: 0, accountsCreated: 0, signIns: 0, demoStarts: 0, revenue: 0 }]),
  );
  const fold = (rows, field, value = 'count') =>
    rows.forEach((r) => {
      const row = series.get(bucketOf(r._id, granularity));
      if (row) row[field] += r[value];
    });
  fold(tenants, 'tenantsCreated');
  fold(accounts, 'accountsCreated');
  fold(signIns, 'signIns');
  fold(demos, 'demoStarts');
  fold(revenue, 'revenue', 'total');

  return {
    granularity,
    range: { from: iso(range.from), before: iso(range.before) },
    series: [...series.values()],
  };
};

// ---- tenants leaderboard ---------------------------------------------------------------------------------

const SORTS = {
  lastActivity: (a, b) => {
    const x = a.lastActivityAt;
    const y = b.lastActivityAt;
    if (x === y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? 1 : -1;
  },
  members: (a, b) => b.counts.members - a.counts.members,
  storage: (a, b) => b.storageUsedBytes - a.storageUsedBytes,
};

const tenants = async (q) => {
  const [docs, detachments, members, workshops, admins] = await Promise.all([
    SaasTenant.find(NOT_DELETED).select('displayName lifecycle.status subscription.status subscription.planId usage').lean(),
    groupCount(Detachment, { status: { $ne: 'archived' } }, 'tenantId'),
    groupCount(TeamMember, { active: true }, 'tenantId'),
    groupCount(Workshop, { archived: { $ne: true } }, 'tenantId'),
    groupCount(Account, { ...TENANT_ADMIN, saasTenantId: { $ne: null } }, 'saasTenantId'),
  ]);
  const items = docs.map((t) => {
    const id = String(t._id);
    return {
      tenantId: id,
      displayName: t.displayName,
      lifecycleStatus: t.lifecycle.status,
      subscriptionStatus: t.subscription.status,
      planId: t.subscription.planId || null,
      counts: {
        detachments: detachments.get(id) || 0,
        members: members.get(id) || 0,
        workshops: workshops.get(id) || 0,
        admins: admins.get(id) || 0,
      },
      storageUsedBytes: (t.usage && t.usage.storageUsedBytes) || 0,
      lastActivityAt: t.usage && t.usage.lastActivityAt ? iso(t.usage.lastActivityAt) : null,
    };
  });
  const by = SORTS[q.sort || 'lastActivity'];
  items.sort((a, b) => by(a, b) || (a.tenantId < b.tenantId ? -1 : 1));
  return { items: items.slice(0, q.limit || 50) };
};

// ---- one tenant ---------------------------------------------------------------------------------------------

const tenant = async (tenantId, q, now = new Date()) => {
  const doc = await SaasTenant.findOne({ _id: tenantId, ...NOT_DELETED });
  if (!doc) throw AppError.notFound('tenant');
  const range = resolveRange(q, now);
  const id = String(doc._id);
  const accountIds = await Account.find({ saasTenantId: id }).distinct('_id');

  const [groups, detachments, members, workshops, admins, announcements, signIns, limits, history] = await Promise.all([
    DetachmentGroup.countDocuments({ tenantId: id }),
    Detachment.countDocuments({ tenantId: id, status: { $ne: 'archived' } }),
    TeamMember.countDocuments({ tenantId: id, active: true }),
    Workshop.countDocuments({ tenantId: id, archived: { $ne: true } }),
    Account.countDocuments({ saasTenantId: id, ...TENANT_ADMIN }),
    Announcement.countDocuments({ tenantId: id, status: 'active' }),
    accountIds.length
      ? Session.countDocuments({ accountId: { $in: accountIds }, scope: 'full', createdAt: { $gte: range.from, $lt: range.before } })
      : 0,
    usageService.limitRows(doc),
    TenantStatusEvent.find({ tenantId: id }).sort({ occurredAt: -1, _id: -1 }).limit(20),
  ]);

  return {
    tenant: {
      id,
      displayName: doc.displayName,
      lifecycleStatus: doc.lifecycle.status,
      subscriptionStatus: doc.subscription.status,
      planId: doc.subscription.planId || null,
      createdAt: iso(doc.createdAt),
    },
    range: { from: iso(range.from), before: iso(range.before) },
    counts: { detachmentGroups: groups, detachments, members, workshops, admins, announcements },
    activity: {
      signInsInRange: signIns,
      lastActivityAt: doc.usage && doc.usage.lastActivityAt ? iso(doc.usage.lastActivityAt) : null,
    },
    limits: limits.rows,
    statusHistory: history.map((e) => ({ id: String(e._id), type: e.type, occurredAt: iso(e.occurredAt), note: e.note || null })),
    generatedAt: iso(now),
  };
};

module.exports = { summary, growth, tenants, tenant, resolveRange, bucketsFor, bucketOf, MAX_BUCKETS };
