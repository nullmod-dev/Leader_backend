/**
 * Optimistic concurrency for versioned tenant records
 * (FRONTEND-BACKEND-INTEGRATION.md §5).
 *
 *  - Every versioned entity carries `version` (JSON integer, starts at 1).
 *  - A mutating request MAY send the `version` it last read (body field).
 *    If it does and the record has moved, the answer is:
 *
 *      409 { error: { code: "stale_write", currentVersion, currentRecord } }
 *
 *    `currentRecord` has exactly the shape of the entity's ordinary GET.
 *  - If it does not send one, the write is last-write-wins (the shipped
 *    Flutter models do not carry `version` yet) — but a race between two
 *    concurrent saves is STILL detected by the conditional save.
 *
 * Append-only resources (inventory movements, attendance corrections) are
 * never versioned and never produce stale_write.
 */
const mongoose = require('mongoose');
const AppError = require('../utils/appError');

const staleWrite = (current, serialize) =>
  new AppError('stale_write', 409, 'The record changed since you last read it.', {
    currentVersion: current ? current.version : null,
    currentRecord: current ? serialize(current) : null,
  });

/** Throw stale_write when the client sent a version that no longer matches. */
const assertVersion = (doc, expectedVersion, serialize) => {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 1) {
    throw AppError.validation({ version: 'version must be a positive integer.' });
  }
  if (doc.version !== expected) throw staleWrite(doc, serialize);
};

/**
 * `doc.save()` that turns a lost race into stale_write.
 * @param doc        a versioned mongoose document
 * @param serialize  (doc) => wire JSON, used for `currentRecord`
 * @param options    forwarded to save (e.g. { session })
 */
const saveVersioned = async (doc, serialize, options = {}) => {
  try {
    return await doc.save(options);
  } catch (err) {
    // DocumentNotFoundError: our `version` guard lost the race.
    // VersionError: Mongoose's own array-versioning (`__v`) lost the race
    // (concurrent edits of attendees / organizingTeam / …). Same meaning.
    if (err instanceof mongoose.Error.DocumentNotFoundError || err instanceof mongoose.Error.VersionError) {
      // Re-read inside the document's own tenant (the data-layer guard
      // refuses a tenant-plane query without one).
      const current = await doc.constructor.findOne({ _id: doc._id, ...(doc.tenantId ? { tenantId: doc.tenantId } : {}) });
      throw staleWrite(current, serialize);
    }
    throw err;
  }
};

module.exports = { assertVersion, saveVersioned, staleWrite };
