/**
 * Identity, sessions & onboarding — mounted at /api/v1/auth.
 * Reference: docs/api/auth.md. (/auth/customer-demo/** is its own router.)
 *
 *   POST   /sign-up                   public · idempotent (required) → 202 Challenge
 *   POST   /sign-in                   public → outcome
 *   POST   /google                    public · idempotent (required) → outcome
 *   POST   /verification/verify       public · idempotent (required) → outcome
 *   POST   /verification/resend       public · idempotent (required) → Challenge
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
 *   POST   /new-device/confirm        full session → 204
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
const v = require('../validators/authValidators');
const identity = require('../controllers/auth/identityController');
const verification = require('../controllers/auth/verificationController');
const onboarding = require('../controllers/auth/onboardingController');
const sessions = require('../controllers/auth/sessionController');
const me = require('../controllers/auth/meController');
const mfa = require('../controllers/auth/mfaController');
const reset = require('../controllers/auth/passwordResetController');

const router = express.Router({ mergeParams: true });

// ---- identity proof -----------------------------------------------------------
router.post('/sign-up', authLimiter, idempotent({ required: true }), validate(v.signUp), identity.signUp);
router.post('/sign-in', authLimiter, validate(v.signIn), identity.signIn);
router.post('/google', idempotent({ required: true }), validate(v.google), identity.google);
router.post('/verification/verify', idempotent({ required: true }), validate(v.verify), verification.verify);
router.post('/verification/resend', idempotent({ required: true }), validate(v.resend), verification.resend);

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
router.post('/new-device/confirm', protect, validate(v.newDevice), sessions.confirmNewDevice);

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
