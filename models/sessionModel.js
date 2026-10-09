/**
 * Session — one refresh-token FAMILY.
 *
 * The access token is a short JWT carrying `sid`; the refresh token is an
 * opaque random string stored only as a hash. Every refresh rotates it: the
 * current hash moves to `previousRefreshHashes`. Presenting a previous
 * (already-rotated) token is replay → the whole family is revoked
 * (API_CONTRACT.md → Token refresh — Point 18B).
 *
 * `scope` is the session tier: `full` or `onboarding` (restricted).
 *
 * Lifetime: `refreshExpiresAt` is the IDLE deadline. Each successful refresh
 * and each GET /auth/me slides it to now + REFRESH_TOKEN_TTL_DAYS, never past
 * `absoluteExpiresAt` (sign-in + SESSION_MAX_DAYS). A session created before
 * `absoluteExpiresAt` existed takes createdAt + SESSION_MAX_DAYS.
 *
 * `deviceRef` is the Device the session was opened on (absent on sessions
 * that predate device trust until their first request carrying X-Device-Id,
 * and on customer-demo sessions).
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const sessionSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    scope: { type: String, enum: ['full', 'onboarding'], required: true },
    refreshHash: { type: String, required: true },
    previousRefreshHashes: { type: [String], default: [] },
    refreshExpiresAt: { type: Date, required: true },
    absoluteExpiresAt: Date,
    deviceRef: { type: String, index: true },
    revokedAt: Date,
    revokeReason: String,

    device: { type: String, default: 'Unknown device' },
    userAgent: String,
    ipMasked: String,
    locationLabel: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },

    // MFA: a full session of an MFA-enabled account starts unverified.
    mfaVerified: { type: Boolean, default: false },
    // "Recent authentication" evidence for privileged platform commands.
    authenticatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'sessions' },
);

sessionSchema.plugin(basePlugin, { prefix: 's', hideTenantId: false });
sessionSchema.index({ refreshHash: 1 });
sessionSchema.index({ previousRefreshHashes: 1 });

sessionSchema.methods.isLive = function isLive(now = new Date()) {
  return !this.revokedAt && this.refreshExpiresAt > now;
};

module.exports = mongoose.models.Session || mongoose.model('Session', sessionSchema);
