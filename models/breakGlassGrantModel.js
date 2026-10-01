/**
 * Break-glass grant — exceptional, temporary, single-tenant, READ-ONLY access
 * bound to ONE Super Admin session. Never a role, never a Cap, never a
 * lifecycle bypass. `revision` is the command concurrency token.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { BREAK_GLASS_STATUS, BREAK_GLASS_END_REASONS, BREAK_GLASS_SCOPES } = require('../config/constants');

const breakGlassGrantSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    revision: { type: Number, default: 1 },
    tenant: { tenantId: { type: String, required: true }, displayName: String },
    scopes: { type: [{ type: String, enum: BREAK_GLASS_SCOPES }], default: ['tenant_operational_read'] },
    reason: { type: String, required: true },
    initiator: { accountId: String, displayName: String },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: BREAK_GLASS_STATUS, default: 'active' },
    endedAt: Date,
    endReason: { type: String, enum: [...BREAK_GLASS_END_REASONS, null], default: undefined },
  },
  { collection: 'break_glass_grants' },
);

breakGlassGrantSchema.plugin(basePlugin, { prefix: 'bg', hideTenantId: false });
breakGlassGrantSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.models.BreakGlassGrant || mongoose.model('BreakGlassGrant', breakGlassGrantSchema);
