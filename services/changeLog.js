/**
 * Manual change-log entries for writes that bypass document middleware
 * (atomic `findOneAndUpdate` / `updateOne`). Document `save()` and
 * `doc.deleteOne()` already record themselves through the base plugin.
 */
const Counter = require('../models/counterModel');
const ChangeLog = require('../models/changeLogModel');

const record = async ({ tenantId, entityType, entityId, op, version, detachmentId }, { session } = {}) => {
  if (!tenantId) return null;
  const seq = await Counter.next(`changelog:${tenantId}`, session);
  const [entry] = await ChangeLog.create([{ tenantId, seq, entityType, entityId: String(entityId), op, version, detachmentId }], { session });
  return entry;
};

/** Record an upsert of a plain/lean document. */
const recordUpsert = (entityType, doc, opts) =>
  record({ tenantId: doc.tenantId, entityType, entityId: doc._id, op: 'upsert', version: doc.version, detachmentId: doc.detachmentId }, opts);

/** Record a delete of a plain/lean document. */
const recordDelete = (entityType, doc, opts) =>
  record({ tenantId: doc.tenantId, entityType, entityId: doc._id, op: 'delete', version: doc.version, detachmentId: doc.detachmentId }, opts);

module.exports = { record, recordUpsert, recordDelete };
