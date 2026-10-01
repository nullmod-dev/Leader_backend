/**
 * Infrastructure collections: idempotency results, the development mailbox,
 * uploaded-file ledger and background-job heartbeats.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

// ---- IdempotencyRecord ---------------------------------------------------------
// `_id` = `<actor>:<Idempotency-Key>`. Same key + same body → the stored
// response is replayed; same key + different body → 409 idempotency_conflict.
const idempotencySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    requestHash: { type: String, required: true },
    method: String,
    path: String,
    state: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    responseStatus: Number,
    responseBody: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'idempotency_records' },
);
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ---- DevMail -----------------------------------------------------------------
// Every outgoing email is recorded here outside production, so Postman, tests
// and the Flutter developer can read OTP codes without an SMTP server.
const devMailSchema = new mongoose.Schema(
  {
    to: { type: String, required: true, index: true },
    subject: String,
    text: String,
    kind: String,
    meta: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'dev_mailbox' },
);
devMailSchema.plugin(basePlugin, { prefix: 'mail', hideTenantId: false });
devMailSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 });

// ---- StoredFile ----------------------------------------------------------------
// Ledger of files written under public/images — drives `storage_bytes` usage
// and lets a replaced/deleted image be removed from disk.
const storedFileSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: null, index: true },
    ownerType: { type: String, required: true },
    ownerId: { type: String, required: true },
    path: { type: String, required: true }, // /images/<folder>/<file>
    bytes: { type: Number, required: true },
    mime: String,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'stored_files' },
);
storedFileSchema.plugin(basePlugin, { prefix: 'file', hideTenantId: false });
storedFileSchema.index({ ownerType: 1, ownerId: 1 });

// ---- JobRun --------------------------------------------------------------------
const jobRunSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // job name
    lastRunAt: Date,
    lastSuccessAt: Date,
    lastStatus: { type: String, enum: ['ok', 'failed'], default: 'ok' },
    lastError: String,
    runs: { type: Number, default: 0 },
    lastAffected: { type: Number, default: 0 },
  },
  { versionKey: false, collection: 'job_runs' },
);

module.exports = {
  IdempotencyRecord: mongoose.models.IdempotencyRecord || mongoose.model('IdempotencyRecord', idempotencySchema),
  DevMail: mongoose.models.DevMail || mongoose.model('DevMail', devMailSchema),
  StoredFile: mongoose.models.StoredFile || mongoose.model('StoredFile', storedFileSchema),
  JobRun: mongoose.models.JobRun || mongoose.model('JobRun', jobRunSchema),
};
