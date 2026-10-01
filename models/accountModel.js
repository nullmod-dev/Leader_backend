/**
 * Account — one administrator login (or one Customer Demo identity).
 *
 * Only administrators authenticate; volunteers are `TeamMember` records and
 * never accounts. `email` is the login identity, never the key: `_id` is the
 * canonical opaque account id and survives auth-method changes.
 *
 * Four independent facts (API_CONTRACT.md → Sign-up principles):
 *   emailVerified · linkStatus · setupCompleted · status (lifecycle)
 *
 * role ↔ saasTenantId invariant:
 *   super_admin / customer_demo → saasTenantId null
 *   main_admin / admin          → saasTenantId required
 *   (unlinked, not-yet-set-up identities have role null)
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const basePlugin = require('./plugins/base');
const { ACCOUNT_STATUS, LINK_STATUS, AUTH_METHODS, ROLES } = require('../config/constants');

const grantSchema = new mongoose.Schema(
  {
    global: { type: [String], default: [] },
    scoped: { type: Map, of: [String], default: {} },
  },
  { _id: false },
);

const accountSchema = new mongoose.Schema(
  {
    email: { type: String, lowercase: true, trim: true },
    name: { type: String, trim: true, default: '' },
    avatarPath: String, // relative public path, e.g. /images/avatars/…
    avatarBytes: { type: Number, default: 0 },

    passwordHash: { type: String, select: false },
    methods: { type: [{ type: String, enum: AUTH_METHODS }], default: [] },
    googleSub: { type: String },
    emailVerified: { type: Boolean, default: false },

    role: { type: String, enum: [...Object.values(ROLES), null], default: null },
    saasTenantId: { type: String, default: null },
    capabilities: { type: grantSchema, default: () => ({ global: [], scoped: {} }) },

    status: { type: String, enum: ACCOUNT_STATUS, default: 'active' },
    suspension: { suspendedAt: Date, reason: String },
    revokedAt: Date,
    activatedAt: Date,

    // Onboarding (machines C and D)
    linkStatus: { type: String, enum: LINK_STATUS, default: 'unlinked' },
    linkedAuthorizationId: { type: String, default: null },
    setupCompleted: { type: Boolean, default: false },
    // Platform-provisioned (a Main Admin seat) before the person claimed it.
    provisioned: { type: Boolean, default: false },

    mfa: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, select: false },
      pendingSecret: { type: String, select: false },
      backupCodeHashes: { type: [String], select: false, default: [] },
      enabledAt: Date,
    },

    notificationPrefs: {
      shiftReminders: { type: Boolean, default: true },
      stockAlerts: { type: Boolean, default: true },
      workshopUpdates: { type: Boolean, default: true },
      joinRequests: { type: Boolean, default: false },
    },

    // Demo identities only
    demoSessionId: String,

    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { timestamps: true, collection: 'accounts' },
);

accountSchema.plugin(basePlugin, { prefix: 'u', hideTenantId: false });

accountSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
accountSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } });
accountSchema.index({ saasTenantId: 1, role: 1 });

accountSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
  this.passwordChangedAt = new Date();
  if (!this.methods.includes('password')) this.methods.push('password');
};

accountSchema.methods.checkPassword = async function checkPassword(plain) {
  if (!this.passwordHash || !plain) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

accountSchema.methods.isTenantAdmin = function isTenantAdmin() {
  return this.role === ROLES.MAIN_ADMIN || this.role === ROLES.ADMIN;
};

module.exports = mongoose.models.Account || mongoose.model('Account', accountSchema);
