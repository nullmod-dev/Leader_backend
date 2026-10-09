/**
 * Identity, sessions & onboarding — mounted at /api/v1/auth.
 * Reference: docs/api/auth.md. (/auth/customer-demo/** is its own router.)
 *
 *   POST   /sign-up                   public · idempotent (required) → 202 Challenge
 *   POST   /sign-in                   public → outcome
 *   POST   /google                    public · idempotent (required) → outcome
 *   POST   /email-status              public · device/IP budget → { status: registered|invited|new }
 *   POST   /sign-in/code              public · device/IP budget → 202 Challenge (purpose sign_in)
 *   POST   /verification/verify       public · IP budget · idempotent (required) → outcome
 *   POST   /verification/resend       public · IP budget · idempotent (required) → Challenge
 *   GET    /onboarding                onboarding session → Snapshot
 *   POST   /onboarding/link           onboarding session · idempotent (required) → Snapshot
 *   POST   /onboarding/complete       onboarding session · idempotent (required, replays) → ready
 *   POST   /sign-out                  any session → 204
 *   POST   /refresh                   public → { accessToken, refreshToken }
 *   GET    /me                        full session (no MFA / status gate) → { user, access }
 *   PATCH  /me                        accountGuard → { user, access }
 *   POST   /me/avatar                 accountGuard · multipart `image` → { user, access }
 *   DELETE /me/avatar                 accountGuard → { user, access }
 *   POST   /me/password               accountGuard → 204
 *   GET    /sessions                  accountGuard → [Session]
 *   DELETE /sessions                  accountGuard → { revoked }
 *   DELETE /sessions/:sessionId       accountGuard → 204
 *   POST   /mfa/setup                 full session + active account → MfaSetupData
 *   POST   /mfa/verify                full session + active account → 204
 *   POST   /mfa/disable               accountGuard → 204
 *   GET    /devices                   accountGuard → { limit, devices: [Device] }
 *   POST   /devices/:deviceId/approve accountGuard, trusted device → 204
 *   POST   /devices/:deviceId/deny    accountGuard, trusted device → { passwordReset }
 *   DELETE /devices/:deviceId         accountGuard → 204
 *   POST   /password-reset/request    public → { resetToken }
 *   POST   /password-reset/verify     reset bearer → 204
 *   POST   /password-reset/complete   reset bearer → 204
 */
const express = require('express');
const { protect, protectOnboarding, protectAny, requireActiveAccount, accountGuard } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const { authLimiter } = require('../middlewares/rateLimit');
const { googleSignInLimiters } = require('../middlewares/googleSignInLimiter');
const { emailEntryLimiters } = require('../middlewares/emailEntryLimiter');
const v = require('../validators/authValidators');
const identity = require('../controllers/auth/identityController');
const emailEntry = require('../controllers/auth/emailEntryController');
const verification = require('../controllers/auth/verificationController');
const onboarding = require('../controllers/auth/onboardingController');
const sessions = require('../controllers/auth/sessionController');
const devices = require('../controllers/auth/devicesController');
const me = require('../controllers/auth/meController');
const mfa = require('../controllers/auth/mfaController');
const reset = require('../controllers/auth/passwordResetController');

const router = express.Router({ mergeParams: true });

// ---- identity proof -----------------------------------------------------------
router.post('/sign-up', authLimiter, idempotent({ required: true }), validate(v.signUp), identity.signUp);
router.post('/sign-in', authLimiter, validate(v.signIn), identity.signIn);
router.post('/google', ...googleSignInLimiters, idempotent({ required: true }), validate(v.google), identity.google);
router.post('/email-status', ...emailEntryLimiters, validate(v.emailStatus), emailEntry.status);
router.post('/sign-in/code', ...emailEntryLimiters, validate(v.signInCode), emailEntry.signInCode);
router.post('/verification/verify', authLimiter, idempotent({ required: true }), validate(v.verify), verification.verify);
router.post('/verification/resend', authLimiter, idempotent({ required: true }), validate(v.resend), verification.resend);

// ---- onboarding (restricted session) ----------------------------------------------
router.get('/onboarding', protectOnboarding, onboarding.get);
router.post('/onboarding/link', protectOnboarding, idempotent({ required: true }), validate(v.link), onboarding.link);
router.post(
  '/onboarding/complete',
  onboarding.stashSubject,
  idempotent({ required: true, actor: onboarding.completeActor }),
  protectOnboarding,
  validate(v.complete),
  onboarding.complete,
);

// ---- sessions ------------------------------------------------------------------------
router.post('/sign-out', protectAny, sessions.signOut);
router.post('/refresh', sessions.refresh);
router.get('/sessions', ...accountGuard, sessions.list);
router.delete('/sessions', ...accountGuard, sessions.revokeOthers);
router.delete('/sessions/:sessionId', ...accountGuard, sessions.revokeOne);

// ---- devices (device trust) ------------------------------------------------------------
router.get('/devices', ...accountGuard, devices.list);
router.post('/devices/:deviceId/approve', ...accountGuard, devices.approve);
router.post('/devices/:deviceId/deny', ...accountGuard, devices.deny);
router.delete('/devices/:deviceId', ...accountGuard, devices.remove);

// ---- the signed-in account ----------------------------------------------------------------
router.get('/me', protect, me.get);
router.patch('/me', ...accountGuard, idempotent(), validate(v.patchMe), me.update);
router.post('/me/avatar', ...accountGuard, idempotent(), imageUpload('image'), me.setAvatar);
router.delete('/me/avatar', ...accountGuard, idempotent(), me.removeAvatar);
router.post('/me/password', ...accountGuard, idempotent(), validate(v.changePassword), me.changePassword);

// ---- second factor ---------------------------------------------------------------------------
router.post('/mfa/setup', protect, requireActiveAccount, mfa.setup);
router.post('/mfa/verify', protect, requireActiveAccount, validate(v.mfaCode), mfa.verify);
router.post('/mfa/disable', ...accountGuard, validate(v.mfaCode), mfa.disable);

// ---- password reset ----------------------------------------------------------------------------
router.post('/password-reset/request', authLimiter, validate(v.resetRequest), reset.request);
router.post('/password-reset/verify', reset.loadReset, validate(v.resetVerify), reset.verify);
router.post('/password-reset/complete', reset.loadReset, validate(v.resetComplete), reset.complete);

module.exports = router;
