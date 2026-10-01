/**
 * TOTP second factor (issuer "Leader", RFC 6238, 30 s, 6 digits, ±1 step).
 *
 *   POST /mfa/setup    → pending secret + 8 single-use backup codes (not yet enabled)
 *   POST /mfa/verify   → confirms the pending secret (enables MFA), OR
 *                        satisfies the MFA challenge of this session
 *   POST /mfa/disable  → verified session + a valid code → MFA off
 *
 * Secrets and backup-code hashes are `select: false` on Account.
 * Failed codes are counted (`mfa_failed`): 10 per 15 minutes per account,
 * then 429 rate_limited.
 */
const crypto = require('crypto');
const { authenticator: baseAuthenticator } = require('otplib');
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account, Session } = require('../../models');
const securityService = require('../../services/securityService');
const { sha256 } = require('../../utils/ids');

const ISSUER = 'Leader';
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 10;
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MFA_BUDGET = { max: 10, windowMinutes: 15 };

const totp = baseAuthenticator.clone({ window: 1 });

const SECRET_FIELDS = '+mfa.secret +mfa.pendingSecret +mfa.backupCodeHashes';

const loadWithSecrets = (accountId) => Account.findById(accountId).select(SECRET_FIELDS);

const newBackupCode = () => {
  let out = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) out += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
  return out;
};

const cleanCode = (value) => String(value || '').replace(/[\s-]/g, '');

const totpMatches = (code, secret) => {
  if (!secret || !/^\d{6}$/.test(code)) return false;
  try {
    return totp.check(code, secret);
  } catch (e) {
    return false;
  }
};

/** Consume a backup code (atomic); true when it was unused. */
const consumeBackupCode = async (account, code) => {
  const hash = sha256(code.toLowerCase());
  if (!(account.mfa.backupCodeHashes || []).includes(hash)) return false;
  const res = await Account.updateOne({ _id: account._id, 'mfa.backupCodeHashes': hash }, { $pull: { 'mfa.backupCodeHashes': hash } });
  return res.modifiedCount === 1;
};

const INVALID = () => new AppError('mfa_code_invalid', 422, 'The code is not correct.');

const failed = async (req, account) => {
  await securityService.signal('mfa_failed', { accountId: String(account._id), ip: req.ip });
  throw INVALID();
};

const markVerified = async (session) => {
  session.mfaVerified = true;
  session.authenticatedAt = new Date();
  await session.save();
};

// POST /auth/mfa/setup → MfaSetupData
exports.setup = catchAsync(async (req, res) => {
  const account = await loadWithSecrets(req.auth.account._id);
  if (account.mfa && account.mfa.enabled) throw AppError.conflict('Two-step verification is already enabled.');

  const secret = totp.generateSecret();
  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
  account.mfa.pendingSecret = secret;
  account.mfa.backupCodeHashes = backupCodes.map((c) => sha256(c));
  await account.save();

  res.status(200).json({
    otpauthUrl: totp.keyuri(account.email, ISSUER, secret),
    manualSecret: secret,
    backupCodes,
  });
});

// POST /auth/mfa/verify {code} → 204
exports.verify = catchAsync(async (req, res) => {
  const { session } = req.auth;
  const account = await loadWithSecrets(req.auth.account._id);
  const code = cleanCode(req.body.code);
  const mfa = account.mfa || {};

  if (mfa.pendingSecret) {
    await securityService.assertBudget('mfa_failed', { accountId: String(account._id) }, MFA_BUDGET);
    if (!totpMatches(code, mfa.pendingSecret)) return failed(req, account);
    const now = new Date();
    account.mfa.secret = mfa.pendingSecret;
    account.mfa.pendingSecret = undefined;
    account.mfa.enabled = true;
    account.mfa.enabledAt = now;
    await account.save();
    await markVerified(session);
    // Every OTHER open session must now pass the second factor too.
    await Session.updateMany(
      { accountId: String(account._id), _id: { $ne: String(session._id) }, revokedAt: { $exists: false } },
      { $set: { mfaVerified: false } },
    );
    return res.status(204).end();
  }

  if (mfa.enabled && !session.mfaVerified) {
    await securityService.assertBudget('mfa_failed', { accountId: String(account._id) }, MFA_BUDGET);
    const ok = totpMatches(code, mfa.secret) || (await consumeBackupCode(account, code));
    if (!ok) return failed(req, account);
    await markVerified(session);
    return res.status(204).end();
  }

  throw AppError.conflict('There is nothing to verify.');
});

// POST /auth/mfa/disable {code} → 204
exports.disable = catchAsync(async (req, res) => {
  const account = await loadWithSecrets(req.auth.account._id);
  if (!account.mfa || !account.mfa.enabled) throw AppError.conflict('Two-step verification is not enabled.');
  await securityService.assertBudget('mfa_failed', { accountId: String(account._id) }, MFA_BUDGET);
  const code = cleanCode(req.body.code);
  const ok = totpMatches(code, account.mfa.secret) || (await consumeBackupCode(account, code));
  if (!ok) return failed(req, account);

  await Account.updateOne(
    { _id: account._id },
    {
      $set: { 'mfa.enabled': false, 'mfa.backupCodeHashes': [] },
      $unset: { 'mfa.secret': '', 'mfa.pendingSecret': '', 'mfa.enabledAt': '' },
    },
  );
  return res.status(204).end();
});
