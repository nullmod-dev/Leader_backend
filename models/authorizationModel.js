/**
 * Authorization — the backend record that lets a verified address become an
 * administrator of one tenant. Three kinds:
 *
 *  - `initial_seat`          — the Main Admin seat of a newly registered tenant
 *  - `replacement_designate` — a pending Main Admin replacement
 *  - `simple_admin`          — a Simple Admin invitation (the management record
 *                              the issuer sees on /tenant/simple-admins)
 *
 * Seat kinds are linked by Team Code (`POST /auth/onboarding/link`); a Simple
 * Admin invitation auto-links on every authoritative read for the verified,
 * normalized address. `complete` consumes it atomically (pending → accepted).
 *
 * status: pending | accepted | cancelled | expired | withdrawn
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const grantSchema = new mongoose.Schema(
  {
    global: { type: [String], default: [] },
    scoped: { type: Map, of: [String], default: {} },
  },
  { _id: false },
);

const authorizationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    kind: { type: String, enum: ['initial_seat', 'replacement_designate', 'simple_admin'], required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ['main_admin', 'admin'], required: true },
    capabilities: { type: grantSchema, default: () => ({ global: [], scoped: {} }) },
    suggestedName: { type: String, default: '' },
    // The provisioned account (seat kinds) created with the authorization.
    accountId: { type: String, default: null },
    // The account that linked to it (set on link / auto-link).
    linkedAccountId: { type: String, default: null },

    status: {
      type: String,
      enum: ['pending', 'accepted', 'cancelled', 'expired', 'withdrawn'],
      default: 'pending',
    },
    expiresAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    cancelledAt: Date,
    withdrawnAt: Date,
    createdBy: { accountId: String, displayName: String },
  },
  { timestamps: true, collection: 'authorizations' },
);

authorizationSchema.plugin(basePlugin, { prefix: 'az', hideTenantId: false });
authorizationSchema.index({ email: 1, status: 1 });

authorizationSchema.methods.isUsable = function isUsable(now = new Date()) {
  return this.status === 'pending' && (!this.expiresAt || this.expiresAt > now);
};

/** Pending but past `expiresAt` reads as expired. */
authorizationSchema.methods.effectiveStatus = function effectiveStatus(now = new Date()) {
  if (this.status === 'pending' && this.expiresAt && this.expiresAt <= now) return 'expired';
  return this.status;
};

module.exports = mongoose.models.Authorization || mongoose.model('Authorization', authorizationSchema);
