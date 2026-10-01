/**
 * Compact tenant/subscription lifecycle chronology
 * (`GET /platform/tenants/:id/status-history`). NOT the platform audit log:
 * no actor, no request data — only what moved and when.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { TENANT_EVENT_TYPES } = require('../config/constants');

const tenantStatusEventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    type: { type: String, enum: TENANT_EVENT_TYPES, required: true },
    occurredAt: { type: Date, default: Date.now },
    note: { type: String, default: null },
  },
  { collection: 'tenant_status_events' },
);

tenantStatusEventSchema.plugin(basePlugin, { prefix: 'evt' });
tenantStatusEventSchema.index({ tenantId: 1, occurredAt: -1 });

module.exports = mongoose.models.TenantStatusEvent || mongoose.model('TenantStatusEvent', tenantStatusEventSchema);
