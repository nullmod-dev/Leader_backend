/**
 * The one error responder. Every failure leaves as
 *
 *   { "error": { "code", "message", "fields"?, ...extensions, "reference" } }
 *
 * The Flutter `Problem.fromJson` reads `error.code` (the ONLY branch key),
 * `error.message` (diagnostics), `error.fields` (field errors) and
 * `error.reference` (support id). Stack traces and internal messages never
 * leave in production.
 */
const mongoose = require('mongoose');
const config = require('../config');
const AppError = require('../utils/appError');

const fromMongoose = (err) => {
  if (err instanceof mongoose.Error.ValidationError) {
    const fields = {};
    Object.values(err.errors).forEach((e) => {
      fields[e.path] = e.message;
    });
    return AppError.validation(fields);
  }
  if (err instanceof mongoose.Error.CastError) return AppError.notFound(err.path || 'resource');
  if (err && err.code === 11000) {
    const fields = {};
    Object.keys(err.keyValue || {}).forEach((k) => {
      fields[k] = 'This value is already in use.';
    });
    return new AppError('conflict', 409, 'A record with the same value already exists.', { fields });
  }
  return null;
};

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  let error = err instanceof AppError ? err : fromMongoose(err);

  if (!error && err && err.type === 'entity.parse.failed') {
    error = AppError.validation({ body: 'The request body is not valid JSON.' });
  }
  if (!error && err && err.type === 'entity.too.large') {
    error = new AppError('payload_too_large', 413, 'The request body is too large.');
  }
  // http-errors from express.static and friends (e.g. a missing /images file).
  if (!error && err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const byStatus = { 404: 'not_found', 403: 'not_permitted', 405: 'not_found', 413: 'payload_too_large' };
    error = new AppError(byStatus[err.status] || 'validation', err.status, err.status === 404 ? 'Not found.' : err.message);
  }
  if (!error) {
    if (!config.isTest) console.error(`[${req.id}]`, err);
    error = new AppError('server', 500, config.isProduction ? 'Something went wrong.' : err.message || 'Something went wrong.');
  }

  const body = { error: { code: error.code, message: error.message, ...error.extensions, reference: req.id } };
  if (error.extensions && error.extensions.retryAfterSeconds) res.set('Retry-After', String(error.extensions.retryAfterSeconds));
  if (!config.isProduction && !config.isTest && error.statusCode >= 500 && err.stack) body.error.stack = err.stack;
  res.status(error.statusCode || 500).json(body);
};
