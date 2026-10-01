/**
 * Customer Demo session — the operational record a Super Admin reads on
 * /platform/operations/demo. `expiresAt` and `policyRevision` are stamped ONCE
 * at creation by server time and never rewritten (policy changes are not
 * retroactive). status: active | expired | terminated; `terminationReason` is
 * metadata on `terminated`, never a fourth status.
 *
 * Never holds a token, credential, device fingerprint or workspace content.
 * `resumeKeyHash` is a hash of the optional client-supplied install id used to
 * resume (not duplicate) a running trial.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { DEMO_SESSION_STATUS, DEMO_TERMINATION_REASONS } = require('../config/constants');

const demoSessionSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    demoWorkspaceId: { type: String, required: true },
    resumeKeyHash: { type: String, default: null },
    displayName: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: DEMO_SESSION_STATUS, default: 'active' },
    policyRevision: { type: Number, required: true },
    endedAt: Date,
    terminationReason: { type: String, enum: [...DEMO_TERMINATION_REASONS, null], default: undefined },
  },
  { timestamps: true, collection: 'demo_sessions' },
);

demoSessionSchema.plugin(basePlugin, { prefix: 'demo', hideTenantId: false });
demoSessionSchema.index({ status: 1, expiresAt: 1 });
demoSessionSchema.index({ resumeKeyHash: 1, status: 1 });

/** Effective status by server time: a stored `active` past `expiresAt` is `expired`. */
demoSessionSchema.methods.statusAt = function statusAt(now = new Date()) {
  if (this.status === 'active' && this.expiresAt <= now) return 'expired';
  return this.status;
};

demoSessionSchema.set('toJSON', {
  transform(doc, ret) {
    const out = {
      demoSessionId: ret._id,
      accountId: ret.accountId,
      demoWorkspaceId: ret.demoWorkspaceId,
      startedAt: ret.startedAt,
      expiresAt: ret.expiresAt,
      status: doc.statusAt ? doc.statusAt() : ret.status,
      policyRevision: ret.policyRevision,
    };
    if (ret.displayName) out.displayName = ret.displayName;
    if (ret.endedAt) out.endedAt = ret.endedAt;
    if (ret.terminationReason) out.terminationReason = ret.terminationReason;
    return out;
  },
});

module.exports = mongoose.models.DemoSession || mongoose.model('DemoSession', demoSessionSchema);
