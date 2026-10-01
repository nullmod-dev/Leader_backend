/**
 * Sign-up, sign-in and Google — the three ways an identity proves itself.
 *
 * Enumeration safety:
 *  - sign-up answers the SAME 202 Challenge for a new, provisioned,
 *    unverified or already-verified address (the last gets a decoy that can
 *    never verify, plus a "someone tried to sign up" mail);
 *  - sign-in answers the SAME 401 invalid_credentials for an unknown
 *    address, an account without a password and a wrong password (a dummy
 *    bcrypt comparison keeps the timing alike).
 */
const bcrypt = require('bcryptjs');
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account } = require('../../models');
const settingsService = require('../../services/settingsService');
const securityService = require('../../services/securityService');
const otpService = require('../../services/otpService');
const googleService = require('../../services/googleService');
const onboarding = require('../../services/onboardingService');

const INVALID_CREDENTIALS = () => new AppError('invalid_credentials', 401, 'The email or password is not correct.');

let dummyHash = null;
/** Spend the same bcrypt work when there is no account to compare against. */
const dummyCompare = async (plain) => {
  if (!dummyHash) dummyHash = await bcrypt.hash('leader-timing-equalizer', 12);
  await bcrypt.compare(String(plain || ''), dummyHash);
};

const isDuplicateKey = (err) => err && err.code === 11000;

// ---------------------------------------------------------------------------
// POST /auth/sign-up  → 202 Challenge
// ---------------------------------------------------------------------------

const signUpOnce = async (address, password) => {
  const account = await Account.findOne({ email: address }).select('+passwordHash');

  if (!account) {
    const fresh = new Account({
      email: address,
      status: 'pending_setup',
      role: null,
      linkStatus: 'unlinked',
      emailVerified: false,
      methods: [],
    });
    await fresh.setPassword(password);
    await fresh.save();
    return otpService.issueChallenge({ email: address, accountId: fresh._id });
  }

  if (account.emailVerified || account.role === 'customer_demo') {
    // Decoy: same response, never verifies; the owner is told by mail.
    await dummyCompare(password);
    return otpService.issueChallenge({ email: address, decoy: true, template: 'signupAttemptOnVerified' });
  }

  // Provisioned/unclaimed (no methods) → attach the password (the person
  // CLAIMS the account, same _id); unverified → replace the password.
  await account.setPassword(password);
  await account.save();
  await otpService.endActiveChallenges(account._id);
  return otpService.issueChallenge({ email: address, accountId: account._id });
};

exports.signUp = catchAsync(async (req, res) => {
  const address = req.body.email;
  const password = onboarding.assertPasswordPolicy(req.body.password, 'password');
  let challenge;
  try {
    challenge = await signUpOnce(address, password);
  } catch (err) {
    // Two sign-ups for a brand-new address raced; the loser takes the
    // "existing account" branch.
    if (!isDuplicateKey(err)) throw err;
    challenge = await signUpOnce(address, password);
  }
  res.status(202).json(otpService.serializeChallenge(challenge));
});

// ---------------------------------------------------------------------------
// POST /auth/sign-in  → outcome
// ---------------------------------------------------------------------------

exports.signIn = catchAsync(async (req, res) => {
  const address = req.body.email;
  const { password } = req.body;
  const { signInLockout } = await settingsService.get();

  await securityService.assertBudget('sign_in_failed', securityService.emailFilter(address), {
    max: signInLockout.maxFailures,
    windowMinutes: signInLockout.windowMinutes,
  });

  const account = await Account.findOne({ email: address }).select('+passwordHash');
  let ok = false;
  if (account && account.role !== 'customer_demo' && (account.methods || []).includes('password') && account.passwordHash) {
    ok = await account.checkPassword(password);
  } else {
    await dummyCompare(password);
  }
  if (!ok) {
    await securityService.signal('sign_in_failed', {
      email: address,
      accountId: account ? String(account._id) : undefined,
      ip: req.ip,
    });
    throw INVALID_CREDENTIALS();
  }

  if (!account.emailVerified) {
    res.status(200).json(await onboarding.verificationRequired(account));
    return;
  }
  res.status(200).json(await onboarding.continueAfterAuthentication(account, req));
});

// ---------------------------------------------------------------------------
// POST /auth/google  → outcome
// ---------------------------------------------------------------------------

/**
 * Map a Google identity onto an account:
 *   googleSub match                        → that account
 *   same email, not yet verified           → CLAIM it (provisioned seat or an
 *                                            unverified password sign-up —
 *                                            the unproven password is dropped)
 *   same email, verified, no such google   → 409 auth_method_link_required
 *   nothing                                → create (methods ['google'])
 */
const resolveGoogleAccount = async (identity) => {
  let account = await Account.findOne({ googleSub: identity.sub }).select('+passwordHash');
  if (account) {
    if (account.role === 'customer_demo') throw new AppError('auth_method_link_required', 409, 'Sign in with your existing method first.');
    if (identity.emailVerified && !account.emailVerified) {
      account.emailVerified = true;
      await account.save();
      await otpService.endActiveChallenges(account._id);
    }
    return account;
  }

  account = await Account.findOne({ email: identity.email }).select('+passwordHash');
  if (account) {
    if (account.emailVerified || account.role === 'customer_demo') {
      throw new AppError('auth_method_link_required', 409, 'This address already signs in with another method.');
    }
    const hadPassword = (account.methods || []).includes('password');
    account.googleSub = identity.sub;
    account.methods = [...(account.methods || []).filter((m) => m !== 'password' && m !== 'google'), 'google'];
    if (hadPassword || account.passwordHash) account.set('passwordHash', undefined);
    account.emailVerified = identity.emailVerified;
    if (!account.name && identity.name) account.name = identity.name;
    await account.save();
    await otpService.endActiveChallenges(account._id);
    return account;
  }

  const fresh = new Account({
    email: identity.email,
    name: identity.name || '',
    status: 'pending_setup',
    role: null,
    linkStatus: 'unlinked',
    emailVerified: identity.emailVerified,
    methods: ['google'],
    googleSub: identity.sub,
  });
  await fresh.save();
  return fresh;
};

exports.google = catchAsync(async (req, res) => {
  const identity = await googleService.verify(req.body.idToken);
  let account;
  try {
    account = await resolveGoogleAccount(identity);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    account = await resolveGoogleAccount(identity);
  }
  if (!account.emailVerified) {
    res.status(200).json(await onboarding.verificationRequired(account));
    return;
  }
  res.status(200).json(await onboarding.continueAfterAuthentication(account, req));
});
