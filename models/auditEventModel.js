/**
 * Immutable, actor-attributed evidence. Appended ONLY by `services/auditService`
 * (which sanitizes before persistence). Two streams:
 *   - `platform` — the Super Admin audit log (`GET /platform/audit`)
 *   - `tenant`   — tenant-scoped admin-management events (`GET /tenant/audit`)
 * There is no update or delete path anywhere in the API.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const valueSchema = new mongoose.Schema(
  { kind: { type: String, enum: ['text', 'bool', 'integer', 'redacted'] }, value: mongoose.Schema.Types.Mixed },
  { _id: false },
);

const auditEventSchema = new mongoose.Schema(
  {
    stream: { type: String, enum: ['platform', 'tenant'], default: 'platform' },
    occurredAt: { type: Date, default: Date.now },
    actor: {
      kind: { type: String, enum: ['platform_administrator', 'tenant_administrator', 'system'], required: true },
      id: String,
      displayName: String,
    },
    action: { type: String, required: true },
    category: { type: String, required: true },
    target: { type: { type: String }, id: String, displayName: String },
    tenant: { id: String, displayName: String, isDeleted: { type: Boolean, default: false } },
    changes: [{ _id: false, field: String, before: valueSchema, after: valueSchema }],
    // For break-glass attribution, never shown as a change.
    grantId: String,
    // Tenant stream scope (== tenant.id); indexed for the tenant read.
    tenantScopeId: String,
  },
  { collection: 'audit_events' },
);

auditEventSchema.plugin(basePlugin, { prefix: 'audit', hideTenantId: false });
auditEventSchema.index({ stream: 1, occurredAt: -1, _id: -1 });
auditEventSchema.index({ stream: 1, tenantScopeId: 1, occurredAt: -1 });
auditEventSchema.index({ 'tenant.id': 1, occurredAt: -1 });
auditEventSchema.index({ action: 1, occurredAt: -1 });

auditEventSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.stream;
    delete ret.tenantScopeId;
    delete ret.grantId;
    if (ret.tenant && !ret.tenant.id) delete ret.tenant;
    return ret;
  },
});

module.exports = mongoose.models.AuditEvent || mongoose.model('AuditEvent', auditEventSchema);
