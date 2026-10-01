/**
 * Multi-document transactions where the deployment supports them.
 *
 * The local dev database (`npm run db`) and the test harness are single-node
 * replica sets, so transactions are real there. Against a standalone mongod
 * the callback still runs, just without a session — every operation in this
 * codebase is also written to be safe in that order (create-then-retire).
 */
const mongoose = require('mongoose');

let supported = null;

const supportsTransactions = async () => {
  if (supported !== null) return supported;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch (e) {
    supported = false;
  }
  return supported;
};

/** Reset the cached capability (tests reconnect to fresh servers). */
const resetSupportCache = () => {
  supported = null;
};

/**
 * Run `fn(session)` inside a transaction (retrying transient errors), or with
 * `session = undefined` when the server cannot do transactions.
 */
const withTransaction = async (fn) => {
  if (!(await supportsTransactions())) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { withTransaction, supportsTransactions, resetSupportCache };
