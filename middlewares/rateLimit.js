/**
 * Coarse per-IP limits in front of public auth endpoints (the fine-grained,
 * per-account budgets live in securityService). Disabled in tests.
 * Refusals use the shared envelope: 429 rate_limited + Retry-After.
 */
const rateLimit = require('express-rate-limit');
const config = require('../config');

const limiter = (max, windowMinutes) =>
  config.rateLimitEnabled
    ? rateLimit({
        windowMs: windowMinutes * 60000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
          const retryAfterSeconds = Math.ceil(windowMinutes * 60);
          res.set('Retry-After', String(retryAfterSeconds));
          res.status(429).json({
            error: { code: 'rate_limited', message: 'Too many requests. Try again later.', retryAfterSeconds, reference: req.id },
          });
        },
      })
    : (req, res, next) => next();

module.exports = {
  authLimiter: limiter(60, 15),
  demoStartLimiter: limiter(20, 60),
  apiLimiter: limiter(3000, 15),
};
