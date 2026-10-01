/**
 * Tenant-scope guard — multi-tenant isolation enforced at the DATA LAYER.
 *
 * Defence in depth: the API already takes the tenant from the verified token
 * and every controller filters on it. This plugin is the second, independent
 * wall: it inspects every database operation on a tenant-plane model and
 * REFUSES it unless it provably stays inside one tenant.
 *
 *  1. Every query / update / delete / count / aggregate must filter on
 *     `tenantId`                                    → else `missing_tenant_filter`
 *  2. Inside a tenant request, that `tenantId` must equal the tenant resolved
 *     from the token (services/tenantContext)       → else `cross_tenant_filter`
 *  3. A document can only be created/saved into the request's tenant
 *                                                   → else `cross_tenant_write`
 *
 * Legitimate cross-tenant work (platform reports, final tenant deletion,
 * background jobs) must SAY so, explicitly and greppably:
 *
 *     Model.find({ status: 'active' }).crossTenant('platform usage report')
 *     Model.aggregate([...]).crossTenant('platform analytics')
 *
 * Document-level writes (`doc.save()`, `doc.deleteOne()`) include `tenantId`
 * in their filter because the schema declares `shardKey: { tenantId: 1 }` —
 * tenantId is this system's natural shard key.
 *
 * Mode (env TENANT_SCOPE_MODE): `enforce` throws `tenant_scope_violation`;
 * `log` only reports (used to discover call sites); `off` (current default)
 * disables the checks. ROLLOUT STATUS: the guard is wired in but defaults to
 * `off` until every legitimate cross-tenant call site is marked with
 * `.crossTenant(reason)`; audit with TENANT_SCOPE_MODE=log, then switch the
 * default to `enforce`. Every violation is logged and recorded as a
 * `tenant_scope_violation` security signal.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const tenantContext = require('../../services/tenantContext');
const AppError = require('../../utils/appError');

const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'replaceOne',
  'distinct',
];

// ---- explicit, greppable opt-out ---------------------------------------------------
if (!mongoose.Query.prototype.crossTenant) {
  /** Mark this query as an intentional cross-tenant operation. */
  mongoose.Query.prototype.crossTenant = function crossTenant(reason = 'unspecified') {
    this._crossTenant = reason;
    return this;
  };
}
if (!mongoose.Aggregate.prototype.crossTenant) {
  mongoose.Aggregate.prototype.crossTenant = function crossTenant(reason = 'unspecified') {
    this._crossTenant = reason;
    return this;
  };
}

const mode = () => (process.env.TENANT_SCOPE_MODE || 'off').toLowerCase();

class TenantScopeViolation extends AppError {
  constructor(kind, modelName, op) {
    // 500: reaching this guard means server code tried to cross the tenant
    // boundary — a bug the guard stopped, never something a client did right.
    super('tenant_scope_violation', 500, `Tenant-scope guard blocked ${op} on ${modelName}: ${kind}`);
    this.name = 'TenantScopeViolation';
    this.kind = kind;
  }
}

const report = (kind, modelName, op, filter) => {
  const ctx = tenantContext.get();
  const line = { at: new Date().toISOString(), kind, model: modelName, op, contextTenant: ctx ? ctx.tenantId : null, filterKeys: Object.keys(filter || {}) };
  if (process.env.TENANT_SCOPE_LOG) {
    const stack = (new Error().stack || '').split('\n').slice(3, 14).join(' | ');
    fs.appendFileSync(process.env.TENANT_SCOPE_LOG, `${JSON.stringify({ ...line, stack })}\n`);
  } else if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.error('[tenant-scope]', JSON.stringify(line));
  }
  // Detection: record a security signal (fire-and-forget; never blocks the request).
  try {
    const { SecuritySignal } = require('..');
    if (SecuritySignal && SecuritySignal.schema.path('kind').enumValues.includes('tenant_scope_violation')) {
      SecuritySignal.create({ kind: 'tenant_scope_violation', tenantId: ctx ? ctx.tenantId : undefined }).catch(() => {});
    }
  } catch (e) {
    /* never let reporting break the request */
  }
};

const violation = (kind, modelName, op, filter) => {
  const m = mode();
  if (m === 'off') return;
  report(kind, modelName, op, filter);
  if (m === 'enforce') throw new TenantScopeViolation(kind, modelName, op);
};

/** The tenantId constraint of a filter (top level or inside a top-level $and). */
const tenantConstraint = (filter) => {
  if (!filter || typeof filter !== 'object') return undefined;
  if (filter.tenantId !== undefined) return filter.tenantId;
  if (Array.isArray(filter.$and)) {
    for (const part of filter.$and) {
      const t = tenantConstraint(part);
      if (t !== undefined) return t;
    }
  }
  return undefined;
};

/** Validate a filter against the rules; returns a violation kind or null. */
const checkFilter = (filter) => {
  const t = tenantConstraint(filter);
  if (t === undefined || t === null) return 'missing_tenant_filter';
  const current = tenantContext.currentTenantId();
  if (!current) return null; // outside a tenant request: presence is enough
  if (typeof t === 'string') return t === current ? null : 'cross_tenant_filter';
  if (t && typeof t === 'object') {
    const ids = Array.isArray(t.$in) ? t.$in : t.$eq !== undefined ? [t.$eq] : null;
    if (!ids || ids.length === 0) return 'cross_tenant_filter';
    return ids.every((x) => String(x) === current) ? null : 'cross_tenant_filter';
  }
  return 'cross_tenant_filter';
};

function tenantScopePlugin(schema) {
  // Document-level writes carry tenantId in their filter.
  schema.set('shardKey', { tenantId: 1 });

  schema.pre(QUERY_OPS, function guardQuery() {
    if (this._crossTenant) return;
    const kind = checkFilter(this.getFilter());
    if (kind) violation(kind, this.model.modelName, this.op, this.getFilter());
  });

  schema.pre('aggregate', function guardAggregate() {
    if (this._crossTenant) return;
    const first = this.pipeline()[0];
    const filter = first && first.$match ? first.$match : null;
    const kind = filter ? checkFilter(filter) : 'missing_tenant_filter';
    if (kind) violation(kind, this._model ? this._model.modelName : 'aggregate', 'aggregate', filter || {});
  });

  // Writes: a document may only land in the request's tenant.
  schema.pre('save', function guardSave() {
    const current = tenantContext.currentTenantId();
    if (!this.tenantId) violation('missing_tenant_on_write', this.constructor.modelName, 'save', {});
    else if (current && this.tenantId !== current) violation('cross_tenant_write', this.constructor.modelName, 'save', { tenantId: 1 });
  });

  schema.pre('insertMany', function guardInsertMany(next, docs) {
    const current = tenantContext.currentTenantId();
    const list = Array.isArray(docs) ? docs : [docs];
    for (const d of list) {
      if (!d || !d.tenantId) violation('missing_tenant_on_write', this.modelName, 'insertMany', {});
      else if (current && d.tenantId !== current) violation('cross_tenant_write', this.modelName, 'insertMany', { tenantId: 1 });
    }
    next();
  });
}

tenantScopePlugin.checkFilter = checkFilter;
tenantScopePlugin.TenantScopeViolation = TenantScopeViolation;
tenantScopePlugin.QUERY_OPS = QUERY_OPS;

module.exports = tenantScopePlugin;
