/**
 * `Idempotency-Key` enforcement (BACKEND-HANDOFF.md §7).
 *
 *   same key + same body      → the ORIGINAL stored response is replayed
 *                               (header `Idempotent-Replayed: true`), no new
 *                               effect, no new audit event
 *   same key + different body → 409 idempotency_conflict
 *   same key still running    → 409 idempotency_in_progress (retry later —
 *                               NOT a failure and NOT a stale write)
 *
 * Keys are scoped per actor (account id, or client IP for public endpoints).
 * 5xx responses are not stored, so a retry after a server fault re-executes.
 * Retention: AppSettings.idempotencyRetentionDays (default 7).
 */
const crypto = require('crypto');
const AppError = require('../utils/appError');
const { IdempotencyRecord } = require('../models');
const settingsService = require('../services/settingsService');

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const KEY_RE = /^[A-Za-z0-9:_\-.]{8,200}$/;

/**
 * @param {object} opts
 * @param {boolean} opts.required  missing header → 422 validation
 * @param {(req) => string|null} [opts.actor]  custom actor scope for the key.
 *   Default: `acc:<accountId>` when authenticated, else `ip:<ip>`. Use a
 *   custom actor when the route must replay AFTER its own credential was
 *   consumed (e.g. onboarding `complete` replays `ready` although the
 *   onboarding session was revoked by the first call).
 */
const idempotent = ({ required = false, actor: actorOf } = {}) => async (req, res, next) => {
  try {
    const key = req.get('idempotency-key');
    if (!key) {
      if (required) throw AppError.validation({ 'Idempotency-Key': 'The Idempotency-Key header is required.' });
      return next();
    }
    if (!KEY_RE.test(key)) throw AppError.validation({ 'Idempotency-Key': 'Invalid Idempotency-Key.' });

    const custom = actorOf ? actorOf(req) : null;
    const actor = custom || (req.auth ? `acc:${req.auth.account._id}` : `ip:${req.ip}`);
    const id = `${actor}:${key}`;
    const requestHash = crypto
      .createHash('sha256')
      .update(`${req.method} ${req.baseUrl}${req.path} ${stable(req.body || {})}`)
      .digest('hex');

    const existing = await IdempotencyRecord.findById(id);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError('idempotency_conflict', 409, 'This Idempotency-Key was used for a different request.');
      }
      if (existing.state === 'in_progress') {
        throw new AppError('idempotency_in_progress', 409, 'The original request is still being processed. Retry shortly.');
      }
      res.set('Idempotent-Replayed', 'true');
      if (existing.responseStatus === 204) return res.status(204).end();
      return res.status(existing.responseStatus).json(existing.responseBody);
    }

    const { idempotencyRetentionDays } = await settingsService.get();
    try {
      await IdempotencyRecord.create({
        _id: id,
        requestHash,
        method: req.method,
        path: `${req.baseUrl}${req.path}`,
        expiresAt: new Date(Date.now() + idempotencyRetentionDays * 86400000),
      });
    } catch (e) {
      if (e && e.code === 11000) {
        throw new AppError('idempotency_in_progress', 409, 'The original request is still being processed. Retry shortly.');
      }
      throw e;
    }

    // Persist the final response BEFORE it is sent, so an immediate retry
    // always sees `completed` (never a stale `in_progress`).
    let persisted = false;
    const persist = async (status, body) => {
      if (persisted) return;
      persisted = true;
      if (status >= 500) {
        await IdempotencyRecord.deleteOne({ _id: id });
        return;
      }
      await IdempotencyRecord.updateOne(
        { _id: id },
        { $set: { state: 'completed', responseStatus: status, responseBody: body === undefined ? null : body } },
      );
    };
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);
    res.json = (payload) => {
      persist(res.statusCode, payload)
        .catch(() => {})
        .finally(() => originalJson(payload));
      return res;
    };
    res.end = (...args) => {
      if (persisted) return originalEnd(...args);
      persist(res.statusCode, null)
        .catch(() => {})
        .finally(() => originalEnd(...args));
      return res;
    };
    req.idempotencyKey = key;
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { idempotent, stable };
