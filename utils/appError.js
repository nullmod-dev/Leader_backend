/**
 * The one error type controllers throw.
 *
 * The Flutter client branches on `code` ONLY (lib/core/problem/problem.dart);
 * `message` is diagnostics. Every error leaves the API as:
 *
 *   { "error": { "code": "not_found", "message": "...", "fields"?: {...},
 *                ...extensions, "reference": "<request id>" } }
 *
 * `extensions` carries typed extra members, e.g. `currentVersion` +
 * `currentRecord` on `stale_write`, `attemptsRemaining` on
 * `verification_code_invalid`, `retryAfterSeconds` on `rate_limited`.
 */
class AppError extends Error {
  /**
   * @param {string} code      snake_case wire code
   * @param {number} statusCode HTTP status
   * @param {string} [message] diagnostic text (never product copy)
   * @param {object} [extensions] extra members merged into `error`
   */
  constructor(code, statusCode = 400, message, extensions = {}) {
    super(message || code);
    this.code = code;
    this.statusCode = statusCode;
    this.extensions = extensions || {};
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static validation(fields = {}, message = 'The request is not valid.') {
    return new AppError('validation', 422, message, { fields });
  }

  static notFound(what = 'resource') {
    return new AppError('not_found', 404, `${what} not found`);
  }

  static notPermitted(message = 'You are not permitted to perform this action.') {
    return new AppError('not_permitted', 403, message);
  }

  static conflict(message = 'The request conflicts with the current state.', extensions) {
    return new AppError('conflict', 409, message, extensions);
  }
}

module.exports = AppError;
