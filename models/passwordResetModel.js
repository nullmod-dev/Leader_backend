/**
 * Password reset: request → verify (code) → complete (new password), all under
 * the opaque reset token returned by `request`. Unknown addresses get a DECOY
 * (same response, can never complete) — enumeration-safe.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const passwordResetSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: null },
    email: { type: String, required: true },
    tokenHash: { type: String, required: true, index: true },
    codeHash: { type: String, select: false },
    verified: { type: Boolean, default: false },
    attemptsRemaining: { type: Number, default: 5 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    decoy: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'password_resets' },
);

passwordResetSchema.plugin(basePlugin, { prefix: 'pr', hideTenantId: false });
passwordResetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.models.PasswordReset || mongoose.model('PasswordReset', passwordResetSchema);
