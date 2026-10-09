/**
 * Sign-up, sign-in and Google — the three ways an identity proves itself.
 *
 * Enumeration safety:
 *  - sign-up answers 202 Challenge for every address. An already-verified
 *    address gets a real SIGN-IN code (`purpose: 'sign_in'`; the typed
 *    password is ignored, never stored) — the same code POST
 *    /auth/sign-in/code sends. A customer demo or a super_admin still gets a
 *    decoy that can never verify, plus a "someone tried to sign up" mail;
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
const deviceService = require('../../services/deviceService');

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

  if (account.role === 'customer_demo' || (account.emailVerified && account.role === 'super_admin')) {
    // Decoy: same response, never verifies; the owner is told by mail.
    await dummyCompare(password);
    return otpService.issueChallenge({ email: address, decoy: true, template: 'signupAttemptOnVerified' });
  }
  if (account.emailVerified) {
    // Already registered: the code signs them in; the typed password is dropped.
    await dummyCompare(password);
    return otpService.signInChallenge({ email: address, accountId: account._id });
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

  // A blocked device learns nothing more than that it is blocked.
  await deviceService.assertNotBlocked(account, req);
  if (account.passwordResetRequired) {
    // A trusted device answered "No" to a new device: the password is known to
    // someone else, so it no longer signs in until it is reset.
    throw new AppError('password_reset_required', 403, 'Reset your password before you sign in with it.');
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
 * Map a Google identity onto an account → `{ account, returning }`:
 *   googleSub match, address verified      → that account, RETURNING
 *   googleSub match                        → that account
 *   same email, linked to another google,  → that account, RETURNING, and the
 *     verified (not super_admin)             new Google identity is NEVER
 *                                            linked: the code alone signs in
 *   same email, linked to another google   → 409 auth_method_link_required
 *     (otherwise)
 *   same email, verified                   → that account, RETURNING (Google
 *                                            is linked once the sign-in code
 *                                            is right — never before)
 *   same email, not yet verified           → CLAIM it (provisioned seat or an
 *                                            unverified password sign-up —
 *                                            the unproven password is dropped)
 *   nothing                                → create (methods ['google'])
 *
 * A RETURNING account is one whose mailbox this app has already proved — it
 * has a past connection with the app — and it proves the mailbox again with a
 * code before the session opens, unless it signs in on one of its trusted
 * devices with the Google identity it already holds. A first Google sign-in
 * on a brand-new account proves the mailbox with the first-device code.
 */
const resolveGoogleAccount = async (identity) => {
  let account = await Account.findOne({ googleSub: identity.sub }).select('+passwordHash');
  if (account) {
    if (account.role === 'customer_demo') throw new AppError('auth_method_link_required', 409, 'Sign in with your existing method first.');
    if (account.emailVerified) return { account, returning: true };
    if (identity.emailVerified) {
      account.emailVerified = true;
      await account.save();
      await otpService.endActiveChallenges(account._id);
    }
    return { account, returning: false };
  }

  account = await Account.findOne({ email: identity.email }).select('+passwordHash');
  if (account) {
    if (account.googleSub && account.emailVerified && account.role !== 'customer_demo' && account.role !== 'super_admin') {
      return { account, returning: true };
    }
    if (account.role === 'customer_demo' || account.googleSub) {
      throw new AppError('auth_method_link_required', 409, 'This address already signs in with another method.');
    }
    if (account.emailVerified) return { account, returning: true };
    const hadPassword = (account.methods || []).includes('password');
    account.googleSub = identity.sub;
    account.methods = [...(account.methods || []).filter((m) => m !== 'password' && m !== 'google'), 'google'];
    if (hadPassword || account.passwordHash) account.set('passwordHash', undefined);
    account.emailVerified = identity.emailVerified;
    if (!account.name && identity.name) account.name = identity.name;
    await account.save();
    await otpService.endActiveChallenges(account._id);
    return { account, returning: false };
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
  return { account: fresh, returning: false };
};

exports.google = catchAsync(async (req, res) => {
  const identity = await googleService.verify(req.body.idToken);
  let resolved;
  try {
    resolved = await resolveGoogleAccount(identity);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    resolved = await resolveGoogleAccount(identity);
  }
  const { account, returning } = resolved;
  // A returning account skips the code only on a device it already trusts,
  // and only with the Google identity it already holds (linking a new one
  // always needs the code). A blocked device is refused here.
  if (returning && account.googleSub === identity.sub && (await deviceService.isTrusted(account, req))) {
    res.status(200).json(await onboarding.continueAfterAuthentication(account, req));
    return;
  }
  if (returning) {
    // The code goes to the account's own address. A Google identity is linked
    // (when that code is right) only to an account that holds none yet; an
    // account linked to another Google identity keeps it.
    const googleSub = account.googleSub ? undefined : identity.sub;
    res.status(200).json(await onboarding.verificationRequired(account, { purpose: 'sign_in', googleSub }));
    return;
  }
  if (!account.emailVerified) {
    res.status(200).json(await onboarding.verificationRequired(account));
    return;
  }
  res.status(200).json(await onboarding.continueAfterAuthentication(account, req));
});
