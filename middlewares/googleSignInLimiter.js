/**
 * Failed-attempt budgets for POST /auth/google only.
 *
 *   per device  6 failed attempts / hour, keyed by `X-Device-Id` — a UUID v4
 *               the app mints once and keeps. A missing or malformed id falls
 *               back to the caller's IP.
 *   per IP      100 failed attempts / hour, a backstop against a client that
 *               rotates device ids. Deliberately loose: many mobile users share
 *               one carrier IP (CGNAT), so the tight budget never keys on an
 *               app user's IP.
 *
 * Only failures count (status >= 400): a successful sign-in gives its hit back.
 * A dismissed account picker never reaches the server. The key is never the
 * email, so nobody can lock a victim out by naming their address.
 *
 * Refusals use the shared envelope: 429 rate_limited + Retry-After, in seconds
 * until this key's window resets. Counters live in process memory: a restart
 * clears them, and several instances would each keep their own. Disabled in
 * tests (`RATE_LIMIT_ENABLED`); the factory is exported for the limiter's own
 * tests.
 */
const net = require('net');
const rateLimit = require('express-rate-limit');
const config = require('../config');

const HOUR_MS = 60 * 60 * 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** IPv6 → its eight hextets (an embedded IPv4 tail only fills two places). */
const hextets = (ip) => {
  const halves = ip.split('%')[0].split('::');
  const groups = (part) => (part ? part.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const head = groups(halves[0]);
  const tail = halves.length > 1 ? groups(halves[1]) : [];
  const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
  return [...head, ...fill, ...tail].map((g) => parseInt(g, 16).toString(16));
};

/**
 * The caller's network key. An IPv6 caller usually holds a whole /64, so a
 * per-address key would let one network rotate addresses; it is grouped.
 */
const ipKey = (req) => {
  const ip = String(req.ip || '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return `ip:${mapped[1]}`;
  if (!net.isIPv6(ip)) return `ip:${ip}`;
  return `ip:${hextets(ip).slice(0, 4).join(':')}::/64`;
};

const deviceKey = (req) => {
  const id = req.get('X-Device-Id');
  return typeof id === 'string' && UUID_V4.test(id) ? `device:${id.toLowerCase()}` : ipKey(req);
};

const refuse = (req, res) => {
  const reset = req.rateLimit && req.rateLimit.resetTime;
  const retryAfterSeconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : HOUR_MS / 1000;
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: {
      code: 'rate_limited',
      message: 'Too many failed Google sign-in attempts. Try again later.',
      retryAfterSeconds,
      reference: req.id,
    },
  });
};

/**
 * @returns {import('express').RequestHandler[]} device limiter, then IP limiter.
 *   The device limiter runs first so a device it refuses never spends the
 *   shared IP budget.
 */
const createGoogleSignInLimiters = ({ deviceLimit = 6, ipLimit = 100, windowMs = HOUR_MS } = {}) => [
  rateLimit({
    windowMs,
    limit: deviceLimit,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    // A refusal from the IP backstop is not this device's failure.
    requestWasSuccessful: (req, res) => res.statusCode < 400 || res.locals.googleIpLimited === true,
    keyGenerator: deviceKey,
    handler: refuse,
  }),
  rateLimit({
    windowMs,
    limit: ipLimit,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: ipKey,
    handler: (req, res) => {
      res.locals.googleIpLimited = true;
      refuse(req, res);
    },
  }),
];

module.exports = {
  googleSignInLimiters: config.rateLimitEnabled ? createGoogleSignInLimiters() : [],
  createGoogleSignInLimiters,
  deviceKey,
  ipKey,
};
