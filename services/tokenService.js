/**
 * Sessions and tokens.
 *
 *  access token  — HS256 JWT { sub: accountId, sid: sessionId, scope, typ:'access' }
 *                  short-lived; the client treats it as opaque and never
 *                  derives authority from it (authority = GET /auth/me).
 *  refresh token — opaque random string; stored only as sha256; single-use.
 *                  Rotation moves the old hash into `previousRefreshHashes`;
 *                  presenting any previous hash = REPLAY → revoke the family.
 *  reset token   — HS256 JWT { sub: resetId, typ:'reset' } for the password
 *                  reset flow's bearer.
 *
 * scope: 'full' | 'onboarding'. An onboarding refresh never yields a full
 * session; a full refresh never downgrades.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Session } = require('../models');
const { randomToken, sha256 } = require('../utils/ids');
const mask = require('../utils/mask');
const AppError = require('../utils/appError');
const securityService = require('./securityService');

const ISSUER = 'leader-api';

const signAccess = (session) =>
  jwt.sign(
    { sub: session.accountId, sid: String(session._id), scope: session.scope, typ: 'access' },
    config.jwtSecret,
    {
      expiresIn: session.scope === 'onboarding' ? config.onboardingTokenTtlSeconds : config.accessTokenTtlSeconds,
      issuer: ISSUER,
    },
  );

const verifyAccess = (token) => {
  const payload = jwt.verify(token, config.jwtSecret, { issuer: ISSUER });
  if (payload.typ !== 'access') throw new Error('wrong token type');
  return payload;
};

/**
 * The subject of a correctly SIGNED access token, even if it has expired.
 * Used only to scope an Idempotency-Key replay (onboarding `complete` must
 * replay its `ready` outcome after its own token was consumed). Never grants
 * access by itself.
 */
const signedSubject = (token) => {
  const payload = jwt.verify(token, config.jwtSecret, { issuer: ISSUER, ignoreExpiration: true });
  if (payload.typ !== 'access') throw new Error('wrong token type');
  return payload.sub;
};

const signReset = (resetId) =>
  jwt.sign({ sub: resetId, typ: 'reset' }, config.jwtSecret, {
    expiresIn: config.resetTokenTtlMinutes * 60,
    issuer: ISSUER,
  });

const verifyReset = (token) => {
  const payload = jwt.verify(token, config.jwtSecret, { issuer: ISSUER });
  if (payload.typ !== 'reset') throw new Error('wrong token type');
  return payload;
};

const describeDevice = (req) => {
  const ua = (req && req.get && req.get('user-agent')) || '';
  const explicit = req && req.get && req.get('x-device-name');
  if (explicit) return explicit.slice(0, 80);
  if (/dart|flutter/i.test(ua)) return 'Leader app';
  if (/postman/i.test(ua)) return 'Postman';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ios/i.test(ua)) return 'iOS';
  if (/windows|macintosh|linux/i.test(ua)) return 'Browser';
  return 'Unknown device';
};

/**
 * Open a new session for `account` and return the credential pair.
 * @returns {{ session, accessToken, refreshToken }}
 */
const createSession = async (account, scope, req, { session: dbSession } = {}) => {
  const refreshToken = randomToken(48);
  const now = new Date();
  const [session] = await Session.create(
    [
      {
        accountId: String(account._id),
        scope,
        refreshHash: sha256(refreshToken),
        refreshExpiresAt: new Date(now.getTime() + config.refreshTokenTtlDays * 86400000),
        device: describeDevice(req),
        userAgent: req && req.get ? (req.get('user-agent') || '').slice(0, 200) : undefined,
        ipMasked: mask.ip(req && req.ip),
        mfaVerified: !(account.mfa && account.mfa.enabled),
        authenticatedAt: now,
      },
    ],
    { session: dbSession },
  );
  return { session, accessToken: signAccess(session), refreshToken };
};

/** Credentials body shared by sign-in `ready`, refresh and demo start. */
const pair = ({ accessToken, refreshToken }) => ({ accessToken, refreshToken });

const REFRESH_FAIL = () => new AppError('authentication_expired', 401, 'The session has ended. Sign in again.');

/**
 * Rotate a refresh token. Every failure is ONE indistinguishable answer.
 */
const refresh = async (refreshToken, req) => {
  if (!refreshToken || typeof refreshToken !== 'string') throw REFRESH_FAIL();
  const hash = sha256(refreshToken);
  const now = new Date();

  const current = await Session.findOne({ refreshHash: hash });
  if (!current) {
    const replayed = await Session.findOne({ previousRefreshHashes: hash });
    if (replayed && !replayed.revokedAt) {
      replayed.revokedAt = now;
      replayed.revokeReason = 'refresh_replay';
      await replayed.save();
      await securityService.signal('refresh_replay', { accountId: replayed.accountId, ip: req && req.ip });
    }
    throw REFRESH_FAIL();
  }
  if (!current.isLive(now)) throw REFRESH_FAIL();

  const { Account } = require('../models');
  const account = await Account.findById(current.accountId);
  if (!account || account.status === 'revoked' || (account.status === 'suspended' && current.scope === 'full')) {
    current.revokedAt = now;
    current.revokeReason = 'account_unavailable';
    await current.save();
    throw REFRESH_FAIL();
  }

  const nextToken = randomToken(48);
  // Atomic rotation: only succeeds if nobody rotated this token concurrently.
  const rotated = await Session.findOneAndUpdate(
    { _id: current._id, refreshHash: hash, revokedAt: { $exists: false } },
    {
      $set: { refreshHash: sha256(nextToken), lastUsedAt: now },
      $push: { previousRefreshHashes: { $each: [hash], $slice: -50 } },
    },
    { new: true },
  );
  if (!rotated) throw REFRESH_FAIL();
  return { accessToken: signAccess(rotated), refreshToken: nextToken, session: rotated };
};

const revokeSession = async (sessionOrId, reason = 'signed_out', { session: dbSession } = {}) => {
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId._id;
  await Session.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokeReason: reason } }, { session: dbSession });
};

/** End every session (and refresh family) of an account — suspend, revoke, reset, replace. */
const revokeAllForAccount = async (accountId, reason, { exceptSessionId, session: dbSession } = {}) => {
  const filter = { accountId: String(accountId), revokedAt: { $exists: false } };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const res = await Session.updateMany(filter, { $set: { revokedAt: new Date(), revokeReason: reason } }, { session: dbSession });
  return res.modifiedCount;
};

module.exports = {
  signAccess,
  verifyAccess,
  signedSubject,
  signReset,
  verifyReset,
  createSession,
  pair,
  refresh,
  revokeSession,
  revokeAllForAccount,
  describeDevice,
};
