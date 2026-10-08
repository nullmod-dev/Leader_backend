/**
 * Email-first entry: what an address is, and a sign-in by email code alone.
 *
 * status — `{ status: 'registered' | 'invited' | 'new' }` and nothing else:
 *   registered  a verified account (not a customer demo)
 *   invited     a usable pending Authorization for the address, or a
 *               provisioned seat account nobody has claimed yet
 *   new         anything else (an unverified sign-up included — signing up
 *               again replaces its password)
 *
 * signInCode — 202 Challenge (`purpose: 'sign_in'`). A registered address
 * gets a real code; anything else, and a super_admin (an email code alone
 * never opens the platform), gets a decoy of the same shape that mails
 * nothing and never verifies. The code finishes through
 * /auth/verification/verify like any other challenge; MFA still applies to
 * the session it opens, and it never links or replaces a Google identity.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const { Account, Authorization } = require('../../models');
const otpService = require('../../services/otpService');

const isRegistered = (account) => Boolean(account && account.emailVerified && account.role !== 'customer_demo');

// POST /auth/email-status → { status }
exports.status = catchAsync(async (req, res) => {
  const address = req.body.email;
  const account = await Account.findOne({ email: address });
  if (isRegistered(account)) {
    res.status(200).json({ status: 'registered' });
    return;
  }
  const now = new Date();
  const invitation = await Authorization.exists({
    email: address,
    status: 'pending',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  });
  const provisioned = account && account.provisioned && !account.emailVerified && (account.methods || []).length === 0;
  res.status(200).json({ status: invitation || provisioned ? 'invited' : 'new' });
});

// POST /auth/sign-in/code → 202 Challenge
exports.signInCode = catchAsync(async (req, res) => {
  const address = req.body.email;
  const account = await Account.findOne({ email: address });
  const real = isRegistered(account) && account.role !== 'super_admin';
  const challenge = await otpService.signInChallenge({ email: address, accountId: real ? account._id : null });
  res.status(202).json(otpService.serializeChallenge(challenge));
});
