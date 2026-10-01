/**
 * Raw security signals (failed sign-ins, Team Code link failures, refresh
 * replay, MFA failures). NOT audit: they feed the computed
 * `GET /platform/security-alerts` snapshot and expire after 30 days.
 * Never stores a password, token, code or full email — only a hash of the
 * address and a masked IP.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const securitySignalSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['sign_in_failed', 'team_link_failed', 'refresh_replay', 'mfa_failed', 'verification_failed', 'reset_failed'],
      required: true,
    },
    accountId: String,
    emailHash: String,
    ipMasked: String,
    tenantId: String,
    occurredAt: { type: Date, default: Date.now },
  },
  { collection: 'security_signals' },
);

securitySignalSchema.plugin(basePlugin, { prefix: 'sig', hideTenantId: false });
securitySignalSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 30 * 86400 });
securitySignalSchema.index({ kind: 1, occurredAt: -1 });

module.exports = mongoose.models.SecuritySignal || mongoose.model('SecuritySignal', securitySignalSchema);
