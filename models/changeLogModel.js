const mongoose = require('mongoose');

/**
 * Per-tenant change feed behind `GET /sync/pull`. Written automatically by the
 * `base` plugin for every tenant-scoped, sync-tracked model. `seq` is a
 * per-tenant monotonic counter, so a pull cursor is just "the last seq I saw".
 */
const changeLogSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    seq: { type: Number, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    op: { type: String, enum: ['upsert', 'delete'], required: true },
    version: Number,
    detachmentId: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'change_log' },
);

changeLogSchema.index({ tenantId: 1, seq: 1 }, { unique: true });
changeLogSchema.index({ tenantId: 1, entityType: 1, entityId: 1, seq: -1 });

module.exports = mongoose.models.ChangeLog || mongoose.model('ChangeLog', changeLogSchema);
