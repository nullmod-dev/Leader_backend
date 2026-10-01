/**
 * Password reset: /forgot → /otp → /new-password.
 *
 *   request  {email}           → ALWAYS 200 { resetToken } (enumeration-safe)
 *   verify   {email, code}     → 204   (Authorization: Bearer <resetToken>)
 *   complete {password}        → 204   (Authorization: Bearer <resetToken>)
 *
 * Unknown addresses and Google-only accounts get a DECOY record: the same
 * token shape, but its code can never verify. A Google-only account is told
 * by mail that there is no password to reset.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account, PasswordReset } = require('../../models');
const tokenService = require('../../services/tokenService');
const otpService = require('../../services/otpService');
const emailService = require('../../services/emailService');
const securityService = require('../../services/securityService');
const onboarding = require('../../services/onboardingService');
const { bearer } = require('../../middlewares/auth');
const { newId, sha256 } = require('../../utils/ids');
const { email: normEmail } = require('../../utils/normalize');

const EXPIRED = () => new AppError('authentication_expired', 401, 'This reset has ended. Start again.');

// POST /auth/password-reset/request {email} → { resetToken }
exports.request = catchAsync(async (req, res) => {
  const address = req.body.email;
  const account = await Account.findOne({ email: address }).select('+passwordHash');
  const methods = account ? account.methods || [] : [];
  const real = !!(account && account.role !== 'customer_demo' && methods.includes('password') && account.passwordHash);

  const resetId = newId('pr');
  const resetToken = tokenService.signReset(resetId);
  const c = await otpService.freshCode();

  if (real) {
    // Only the newest reset of an account stays usable.
    await PasswordReset.updateMany(
      { accountId: String(account._id), usedAt: { $exists: false }, attemptsRemaining: { $gt: 0 } },
      { $set: { attemptsRemaining: 0 } },
    );
  }
  await PasswordReset.create({
    _id: resetId,
    accountId: real ? String(account._id) : null,
    email: address,
    tokenHash: sha256(resetToken),
    codeHash: real ? c.codeHash : undefined,
    attemptsRemaining: c.attemptsRemaining,
    expiresAt: c.expiresAt,
    decoy: !real,
  });

  if (real) {
    await emailService.sendTemplate(address, 'passwordResetCode', { code: c.code, minutes: c.minutes });
  } else if (account && methods.includes('google') && account.role !== 'customer_demo') {
    await emailService.sendTemplate(address, 'googleOnlyReset', {});
  }
  res.status(200).json({ resetToken });
});

/** Resolve the reset bearer into req.reset (every failure → 401 authentication_expired). */
exports.loadReset = catchAsync(async (req, res, next) => {
  const token = bearer(req);
  if (!token) throw EXPIRED();
  let payload;
  try {
    payload = tokenService.verifyReset(token);
  } catch (e) {
    throw EXPIRED();
  }
  const reset = await PasswordReset.findById(String(payload.sub)).select('+codeHash');
  if (!reset || reset.tokenHash !== sha256(token) || reset.usedAt || reset.attemptsRemaining <= 0) throw EXPIRED();
  req.reset = reset;
  next();
});

// POST /auth/password-reset/verify {email, code} → 204
exports.verify = catchAsync(async (req, res) => {
  const { reset } = req;
  if (new Date() >= reset.expiresAt) {
    throw new AppError('reset_code_expired', 409, 'The code has expired. Request a new one.');
  }
  const correct =
    !reset.decoy && reset.accountId && normEmail(req.body.email) === reset.email && otpService.matches(reset.codeHash, req.body.code);
  if (!correct) {
    const spent = await PasswordReset.findOneAndUpdate(
      { _id: reset._id, attemptsRemaining: { $gt: 0 } },
      { $inc: { attemptsRemaining: -1 } },
      { new: true },
    );
    await securityService.signal('reset_failed', { accountId: reset.accountId || undefined, email: reset.email, ip: req.ip });
    if (!spent) throw EXPIRED();
    throw new AppError('reset_code_invalid', 422, 'The code is not correct.', { attemptsRemaining: spent.attemptsRemaining });
  }
  if (!reset.verified) {
    reset.verified = true;
    await reset.save();
  }
  res.status(204).end();
});

// POST /auth/password-reset/complete {password} → 204
exports.complete = catchAsync(async (req, res) => {
  const { reset } = req;
  if (reset.decoy || !reset.verified || !reset.accountId) throw EXPIRED();
  const password = onboarding.assertPasswordPolicy(req.body.password, 'password');

  const account = await Account.findById(reset.accountId).select('+passwordHash');
  if (!account) throw EXPIRED();
  // Single use under concurrency.
  const used = await PasswordReset.findOneAndUpdate(
    { _id: reset._id, verified: true, usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!used) throw EXPIRED();

  await account.setPassword(password);
  // Receiving the code proved ownership of the address.
  account.emailVerified = true;
  await account.save();
  await otpService.endActiveChallenges(account._id);
  await tokenService.revokeAllForAccount(account._id, 'password_reset');
  res.status(204).end();
});
