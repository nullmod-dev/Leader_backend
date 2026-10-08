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

/** The mail that carries a challenge's code, by the challenge's purpose. */
const CODE_TEMPLATES = { email: 'verificationCode', sign_in: 'signInCode' };

/** Wire shape of a challenge (Flutter VerificationChallenge). */
const serializeChallenge = (ch) => ({
  challengeId: String(ch._id),
  maskedEmail: mask.email(ch.email),
  codeLength: ch.codeLength,
  expiresAt: ch.expiresAt.toISOString(),
  resendAvailableAt: ch.resendAvailableAt.toISOString(),
  attemptsRemaining: ch.attemptsRemaining,
  // Only a sign-in challenge names its purpose; an email-ownership challenge
  // keeps its original shape.
  ...(ch.purpose === 'sign_in' ? { purpose: 'sign_in' } : {}),
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
 * @param {'email'|'sign_in'} [p.purpose]
 * @param {string} [p.googleSub]  sign_in only: the Google subject to link on success
 * @param {'verificationCode'|'signInCode'|'signupAttemptOnVerified'|null} [p.template]
 */
const issueChallenge = async ({
  email,
  accountId = null,
  decoy = false,
  purpose = 'email',
  googleSub,
  template = CODE_TEMPLATES[purpose],
}) => {
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
    purpose,
    googleSub,
  });
  if (Object.values(CODE_TEMPLATES).includes(template)) {
    await emailService.sendTemplate(email, template, { code: c.code, minutes: c.minutes });
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
  if (!ch.decoy) {
    const template = CODE_TEMPLATES[ch.purpose] || CODE_TEMPLATES.email;
    await emailService.sendTemplate(ch.email, template, { code: c.code, minutes: c.minutes });
  }
  return ch;
};

/**
 * A sign-in code for an email-only sign-in (POST /auth/sign-in/code, or a
 * sign-up on an address that is already verified). `accountId` null → a
 * decoy that looks the same, mails nothing and never verifies.
 *
 * While this address's last such challenge is still inside its resend
 * cooldown, that SAME challenge is answered again with no new mail, so
 * repeated taps never flood the mailbox. It never carries a Google subject:
 * an email-only sign-in links nothing.
 */
const signInChallenge = async ({ email, accountId = null }) => {
  const now = new Date();
  const decoy = !accountId;
  const current = await VerificationChallenge.findOne({
    email,
    accountId: decoy ? null : String(accountId),
    decoy,
    purpose: 'sign_in',
    status: 'active',
    googleSub: { $exists: false },
    expiresAt: { $gt: now },
    resendAvailableAt: { $gt: now },
  }).sort({ createdAt: -1 });
  if (current) return current;
  if (decoy) return issueChallenge({ email, decoy: true, purpose: 'sign_in', template: null });
  await endActiveChallenges(accountId);
  return issueChallenge({ email, accountId, purpose: 'sign_in' });
};

module.exports = {
  hashCode,
  matches,
  freshCode,
  serializeChallenge,
  endActiveChallenges,
  issueChallenge,
  rearmChallenge,
  signInChallenge,
};
