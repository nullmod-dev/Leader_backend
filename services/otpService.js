/**
 * One-time codes for email ownership (VerificationChallenge) and password
 * reset (PasswordReset).
 *
 *  - A code is `settings.otp.length` digits (or `DEV_FIXED_OTP` outside
 *    production). Only its sha256 is stored (`codeHash`, select:false — load
 *    it with `.select('+codeHash')`).
 *  - expiresAt = now + otp.ttlMinutes · resendAvailableAt = now +
 *    otp.resendCooldownSeconds · attemptsRemaining = otp.maxAttempts.
 *  - A DECOY challenge (`accountId: null, decoy: true`) looks identical on the
 *    wire and can never verify — sign-up stays enumeration-safe.
 *
 * Codes are never logged and never returned by the API.
 */
const crypto = require('crypto');
const config = require('../config');
const { VerificationChallenge } = require('../models');
const settingsService = require('./settingsService');
const emailService = require('./emailService');
const mask = require('../utils/mask');
const { sha256 } = require('../utils/ids');

const hashCode = (code) => sha256(String(code));

/** Constant-time comparison of a stored hash against a typed code. */
const matches = (storedHash, typed) => {
  if (!storedHash || typed === undefined || typed === null) return false;
  const a = Buffer.from(String(storedHash), 'hex');
  const b = Buffer.from(hashCode(String(typed).trim()), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const randomDigits = (length) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(crypto.randomInt(0, 10));
  return out;
};

/** A fresh code + its hash + the timing fields from the OTP policy. */
const freshCode = async (now = new Date()) => {
  const { otp } = await settingsService.get();
  const code = config.devFixedOtp ? String(config.devFixedOtp) : randomDigits(otp.length);
  return {
    code,
    codeHash: hashCode(code),
    codeLength: code.length,
    minutes: otp.ttlMinutes,
    expiresAt: new Date(now.getTime() + otp.ttlMinutes * 60000),
    resendAvailableAt: new Date(now.getTime() + otp.resendCooldownSeconds * 1000),
    attemptsRemaining: otp.maxAttempts,
  };
};

/** Wire shape of a challenge (Flutter VerificationChallenge). */
const serializeChallenge = (ch) => ({
  challengeId: String(ch._id),
  maskedEmail: mask.email(ch.email),
  codeLength: ch.codeLength,
  expiresAt: ch.expiresAt.toISOString(),
  resendAvailableAt: ch.resendAvailableAt.toISOString(),
  attemptsRemaining: ch.attemptsRemaining,
});

/** End every ACTIVE challenge of an account (optionally keeping one). */
const endActiveChallenges = async (accountId, { exceptId, session } = {}) => {
  if (!accountId) return 0;
  const filter = { accountId: String(accountId), status: 'active' };
  if (exceptId) filter._id = { $ne: String(exceptId) };
  const res = await VerificationChallenge.updateMany(filter, { $set: { status: 'ended', endedAt: new Date() } }, { session });
  return res.modifiedCount;
};

/**
 * Create a challenge and send its mail.
 * @param {object} p
 * @param {string} p.email      normalized address
 * @param {string|null} p.accountId  null for a decoy
 * @param {boolean} [p.decoy]
 * @param {'verificationCode'|'signupAttemptOnVerified'|null} [p.template]
 */
const issueChallenge = async ({ email, accountId = null, decoy = false, template = 'verificationCode' }) => {
  const c = await freshCode();
  const ch = await VerificationChallenge.create({
    accountId: decoy ? null : String(accountId),
    email,
    codeHash: c.codeHash,
    codeLength: c.codeLength,
    expiresAt: c.expiresAt,
    resendAvailableAt: c.resendAvailableAt,
    attemptsRemaining: c.attemptsRemaining,
    decoy,
  });
  if (template === 'verificationCode') {
    await emailService.sendTemplate(email, 'verificationCode', { code: c.code, minutes: c.minutes });
  } else if (template) {
    await emailService.sendTemplate(email, template, {});
  }
  return ch;
};

/**
 * Re-arm the SAME challenge with a new code (resend): expiry, cooldown and
 * attempts all reset. Decoys re-arm silently (no mail).
 */
const rearmChallenge = async (ch) => {
  const c = await freshCode();
  ch.codeHash = c.codeHash;
  ch.codeLength = c.codeLength;
  ch.expiresAt = c.expiresAt;
  ch.resendAvailableAt = c.resendAvailableAt;
  ch.attemptsRemaining = c.attemptsRemaining;
  await ch.save();
  if (!ch.decoy) await emailService.sendTemplate(ch.email, 'verificationCode', { code: c.code, minutes: c.minutes });
  return ch;
};

module.exports = {
  hashCode,
  matches,
  freshCode,
  serializeChallenge,
  endActiveChallenges,
  issueChallenge,
  rearmChallenge,
};
