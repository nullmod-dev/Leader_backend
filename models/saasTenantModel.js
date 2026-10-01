/**
 * SaasTenant — one paying Leader subscriber: the billing, security and
 * data-isolation boundary. NOT a DetachmentGroup (a grouping inside a tenant)
 * and NOT a Customer Demo (which has no tenant at all).
 *
 * Three concurrency tokens, deliberately independent:
 *   lifecycle.version      — lifecycle commands     (409 stale_tenant)
 *   subscription.version   — commercial commands    (409 stale_subscription)
 *   features[].version     — per-feature row        (409 stale_feature_state)
 * plus `seat.revision` (Main Admin seat) and `adminManagementRevision`
 * (Simple Admin management).
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const {
  TENANT_STATUS,
  SUBSCRIPTION_STATUS,
  FEATURE_KEYS,
  DEFAULT_ENABLED_FEATURES,
} = require('../config/constants');

const featureSchema = new mongoose.Schema(
  {
    key: { type: String, enum: FEATURE_KEYS, required: true },
    enabled: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const saasTenantSchema = new mongoose.Schema(
  {
    displayName: { type: String, required: true, trim: true },
    teamCode: { type: String, required: true }, // canonical MTM-XXXX-XXXX
    timezone: { type: String, default: 'Asia/Damascus' },

    lifecycle: {
      status: { type: String, enum: TENANT_STATUS, default: 'active' },
      version: { type: Number, default: 1 },
      suspension: { suspendedAt: Date, reason: String },
      deletion: {
        requestedAt: Date,
        scheduledFor: Date,
        previousStatus: { type: String, enum: ['active', 'suspended', null], default: undefined },
        reason: String,
      },
    },

    subscription: {
      status: { type: String, enum: SUBSCRIPTION_STATUS, default: 'trial' },
      planId: { type: String, default: null },
      version: { type: Number, default: 1 },
      trialEndsAt: { type: Date, default: null },
      renewsAt: { type: Date, default: null },
      graceEndsAt: { type: Date, default: null },
      limitOverrides: { type: Map, of: Number, default: {} },
      // Snapshot of the last price actually paid (commerce checkout).
      lastPayment: {
        billingOrderId: String,
        billingOptionId: String,
        amount: Number,
        currency: String,
        paidAt: Date,
      },
    },

    features: {
      type: [featureSchema],
      default: () =>
        FEATURE_KEYS.map((key) => ({ key, enabled: DEFAULT_ENABLED_FEATURES.includes(key), version: 1, updatedAt: new Date() })),
    },

    // Main Admin seat (Point 14). The current holder's state lives on Account.
    seat: {
      revision: { type: Number, default: 1 },
      currentAccountId: { type: String, default: null },
      replacement: {
        id: String,
        status: { type: String, enum: ['pending', null], default: undefined },
        designateAccountId: String,
        authorizationId: String,
        requestedAt: Date,
        reason: String,
      },
    },

    adminManagementRevision: { type: Number, default: 1 },

    // Tenant-editable organisation profile (org.edit) — never includes the Team Code.
    org: {
      legalName: { type: String, default: '' },
      address: { type: String, default: '' },
      emailPublic: { type: String, default: '' },
      logoPath: String,
    },

    usage: {
      storageUsedBytes: { type: Number, default: 0 },
      storageAllowanceBytes: { type: Number, default: null },
      lastActivityAt: { type: Date, default: null },
    },
  },
  { timestamps: true, collection: 'saas_tenants' },
);

saasTenantSchema.plugin(basePlugin, { prefix: 'saas', hideTenantId: false });

// Team Code uniqueness under concurrency: a unique index, never read-then-write.
saasTenantSchema.index({ teamCode: 1 }, { unique: true });
saasTenantSchema.index({ createdAt: -1, _id: -1 });
saasTenantSchema.index({ 'lifecycle.status': 1, 'subscription.status': 1 });

saasTenantSchema.methods.featureEnabled = function featureEnabled(key) {
  const row = (this.features || []).find((f) => f.key === key);
  return !!(row && row.enabled === true);
};

/** List projection status: a blocking lifecycle state wins over commercial status. */
saasTenantSchema.methods.listStatus = function listStatus() {
  const s = this.lifecycle?.status;
  if (s === 'suspended' || s === 'deletion_pending' || s === 'deleted') return s;
  return this.subscription?.status || 'trial';
};

module.exports = mongoose.models.SaasTenant || mongoose.model('SaasTenant', saasTenantSchema);
