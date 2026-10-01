/**
 * Opaque cursors. The client echoes them back unread and must not be able to
 * infer an offset, id or sort key (API_CONTRACT.md → GET /platform/tenants).
 * They are base64url JSON with a version tag; a malformed cursor is a typed
 * `validation` failure, never a silent restart.
 */
const AppError = require('./appError');

const encode = (payload) => Buffer.from(JSON.stringify({ v: 1, ...payload })).toString('base64url');

const decode = (cursor) => {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || parsed.v !== 1) throw new Error('bad version');
    return parsed;
  } catch (e) {
    throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
  }
};

/** Clamp a `limit` query param into [1, max], default `def`. */
const limitOf = (value, def = 50, max = 100) => {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw AppError.validation({ limit: `limit must be an integer between 1 and ${max}.` });
  }
  return n;
};

module.exports = { encode, decode, limitOf };
