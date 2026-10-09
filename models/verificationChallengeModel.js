/**
 * Email-ownership challenge (onboarding machine B). The client only ever holds
 * the opaque `challengeId`. A DECOY challenge (sign-up with an already-verified
 * address) has `accountId: null` and can never verify — that is what keeps
 * sign-up enumeration-safe.
 *
 * purpose 'sign_in' — a returning account proving its mailbox again before a
 * Google sign-in opens a session. It may carry the Google subject to link to
 * the account once the code is right (a verified account that so far signed
 * in only with a password).
 *
 * purpose 'new_device' — a password or Google sign-in from a device this
 * account does not trust yet (or the account's very first device): the code
 * proves the mailbox before the session opens on that device.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const challengeSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: null, index: true },
    email: { type: String, required: true },
    codeHash: { type: String, select: false },
    codeLength: { type: Number, default: 6 },
    expiresAt: { type: Date, required: true },
    resendAvailableAt: { type: Date, required: true },
    attemptsRemaining: { type: Number, required: true },
    status: { type: String, enum: ['active', 'verified', 'ended'], default: 'active' },
    decoy: { type: Boolean, default: false },
    purpose: { type: String, enum: ['email', 'sign_in', 'new_device'], default: 'email' },
    googleSub: { type: String, select: false },
    endedAt: Date,
  },
  { timestamps: true, collection: 'verification_challenges' },
);

challengeSchema.plugin(basePlugin, { prefix: 'vc', hideTenantId: false });
// Challenges are short-lived; Mongo removes them a day after creation.
challengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.models.VerificationChallenge || mongoose.model('VerificationChallenge', challengeSchema);
