/**
 * Email-ownership challenge: verify a code, resend a code.
 *
 * verify — unknown/ended → 409 verification_challenge_ended; past expiresAt →
 * 409 verification_code_expired (no attempt spent); wrong code (a decoy is
 * always wrong) → one attempt spent → 422 verification_code_invalid
 * (+attemptsRemaining), and the attempt that reaches 0 ends the challenge
 * (409 verification_challenge_ended). Correct → the account's address is
 * verified and the sign-in continues (ready / onboarding).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account, VerificationChallenge } = require('../../models');
const otpService = require('../../services/otpService');
const securityService = require('../../services/securityService');
const onboarding = require('../../services/onboardingService');

const ENDED = () => new AppError('verification_challenge_ended', 409, 'This verification has ended. Start again.');

const loadActive = async (challengeId) => {
  const ch = await VerificationChallenge.findById(String(challengeId)).select('+codeHash');
  if (!ch || ch.status !== 'active') throw ENDED();
  return ch;
};

const endChallenge = (id) =>
  VerificationChallenge.updateOne({ _id: id, status: 'active' }, { $set: { status: 'ended', endedAt: new Date() } });

// POST /auth/verification/verify → outcome
exports.verify = catchAsync(async (req, res) => {
  const ch = await loadActive(req.body.challengeId);
  const now = new Date();
  if (now >= ch.expiresAt) {
    throw new AppError('verification_code_expired', 409, 'The code has expired. Request a new one.');
  }

  const correct = !ch.decoy && ch.accountId && otpService.matches(ch.codeHash, req.body.code);
  if (!correct) {
    const spent = await VerificationChallenge.findOneAndUpdate(
      { _id: ch._id, status: 'active', attemptsRemaining: { $gt: 0 } },
      { $inc: { attemptsRemaining: -1 } },
      { new: true },
    );
    await securityService.signal('verification_failed', { accountId: ch.accountId || undefined, email: ch.email, ip: req.ip });
    if (!spent || spent.attemptsRemaining <= 0) {
      await endChallenge(ch._id);
      throw ENDED();
    }
    throw new AppError('verification_code_invalid', 422, 'The code is not correct.', { attemptsRemaining: spent.attemptsRemaining });
  }

  // Single use: only one concurrent request may consume the challenge.
  const consumed = await VerificationChallenge.findOneAndUpdate(
    { _id: ch._id, status: 'active' },
    { $set: { status: 'verified', endedAt: now } },
    { new: true },
  );
  if (!consumed) throw ENDED();

  const account = await Account.findById(ch.accountId);
  if (!account) throw ENDED();
  if (!account.emailVerified) {
    account.emailVerified = true;
    await account.save();
  }
  await otpService.endActiveChallenges(account._id);

  res.status(200).json(await onboarding.continueAfterAuthentication(account, req));
});

// POST /auth/verification/resend → 200 Challenge (same challengeId)
exports.resend = catchAsync(async (req, res) => {
  const ch = await loadActive(req.body.challengeId);
  const now = Date.now();
  if (now < ch.resendAvailableAt.getTime()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((ch.resendAvailableAt.getTime() - now) / 1000));
    throw new AppError('verification_resend_throttled', 429, 'Wait before requesting another code.', {
      retryAfterSeconds,
      resendAvailableAt: ch.resendAvailableAt.toISOString(),
    });
  }
  await otpService.rearmChallenge(ch);
  res.status(200).json(otpService.serializeChallenge(ch));
});
