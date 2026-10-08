/**
 * Request budgets for POST /auth/email-status and POST /auth/sign-in/code.
 *
 *   per device  20 requests / hour, keyed by `X-Device-Id` (UUID v4); a
 *               missing or malformed id falls back to the caller's IP.
 *   per IP      200 requests / hour, a backstop against rotated device ids,
 *               loose because carrier IPs are shared (CGNAT).
 *
 * Unlike the Google limiter EVERY request counts: a successful answer is
 * exactly what an address-probing client is after. The key is never the
 * email, so nobody can lock a victim out by naming their address.
 *
 * Refusals: 429 rate_limited + Retry-After. Counters live in process memory.
 * Disabled in tests (`RATE_LIMIT_ENABLED`); the factory is exported for the
 * limiter's own tests. Keys come from googleSignInLimiter.
 */
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { deviceKey, ipKey } = require('./googleSignInLimiter');

const HOUR_MS = 60 * 60 * 1000;

const refuse = (req, res) => {
  const reset = req.rateLimit && req.rateLimit.resetTime;
  const retryAfterSeconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : HOUR_MS / 1000;
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: {
      code: 'rate_limited',
      message: 'Too many requests. Try again later.',
      retryAfterSeconds,
      reference: req.id,
    },
  });
};

/**
 * @returns {import('express').RequestHandler[]} device limiter, then IP
 *   limiter. A request the device limiter refuses never reaches the IP one.
 */
const createEmailEntryLimiters = ({ deviceLimit = 20, ipLimit = 200, windowMs = HOUR_MS } = {}) => [
  rateLimit({ windowMs, limit: deviceLimit, standardHeaders: false, legacyHeaders: false, keyGenerator: deviceKey, handler: refuse }),
  rateLimit({ windowMs, limit: ipLimit, standardHeaders: false, legacyHeaders: false, keyGenerator: ipKey, handler: refuse }),
];

// One shared budget for both endpoints: a status check and a code request
// draw from the same allowance.
module.exports = {
  emailEntryLimiters: config.rateLimitEnabled ? createEmailEntryLimiters() : [],
  createEmailEntryLimiters,
};
