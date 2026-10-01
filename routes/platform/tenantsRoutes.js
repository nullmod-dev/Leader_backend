/**
 * /api/v1/platform/tenants — SaaS subscribers (control plane, super_admin only).
 * See docs/api/platform-tenants.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformTenantValidators');
const tenants = require('../../controllers/platform/tenantsController');
const lifecycle = require('../../controllers/platform/lifecycleController');
const subscription = require('../../controllers/platform/subscriptionController');
const features = require('../../controllers/platform/featuresController');
const mainAdmin = require('../../controllers/platform/mainAdminController');

const router = express.Router({ mergeParams: true });
const idem = idempotent({ required: true });

router.use(platformGuard);

// ---- tenants ---------------------------------------------------------------------------
router.get('/', validate(v.listTenantsQuery, 'query'), tenants.list);
router.get('/suggest-team-code', tenants.suggestTeamCode);
router.post('/', idem, validate(v.createTenant), tenants.create);
router.get('/:tenantId', tenants.get);
router.get('/:tenantId/status-history', tenants.statusHistory);

// ---- lifecycle (Point 9) -------------------------------------------------------------------
router.post('/:tenantId/lifecycle/suspend', idem, validate(v.lifecycleWithReason), lifecycle.suspend);
router.post('/:tenantId/lifecycle/reactivate', idem, validate(v.lifecycleVersionOnly), lifecycle.reactivate);
router.post('/:tenantId/lifecycle/deletion/begin', idem, validate(v.lifecycleWithReason), lifecycle.beginDeletion);
router.post('/:tenantId/lifecycle/deletion/cancel', idem, validate(v.lifecycleVersionOnly), lifecycle.cancelDeletion);
router.post('/:tenantId/lifecycle/deletion/finalize', idem, validate(v.lifecycleVersionOnly), lifecycle.finalizeDeletion);

// ---- subscription & limits (Point 7) ----------------------------------------------------------
router.get('/:tenantId/subscription', subscription.get);
router.get('/:tenantId/limits', subscription.limits);
router.post('/:tenantId/subscription/activate', idem, validate(v.activateSubscription), subscription.activate);
router.post('/:tenantId/subscription/trial/extend', idem, validate(v.extendTrial), subscription.extendTrial);
router.post('/:tenantId/subscription/trial/end', idem, validate(v.subscriptionVersionOnly), subscription.endTrial);
router.post('/:tenantId/subscription/grace', idem, validate(v.subscriptionVersionOnly), subscription.moveToGrace);
router.post('/:tenantId/subscription/plan', idem, validate(v.changePlan), subscription.changePlan);
router.patch('/:tenantId/limits/:limitKey', idem, validate(v.limitOverride), subscription.setLimitOverride);

// ---- features (Point 8) --------------------------------------------------------------------------
router.get('/:tenantId/features', features.list);
router.patch('/:tenantId/features/:featureKey', idem, validate(v.featurePatch), features.update);

// ---- Main Admin seat (Point 14) ---------------------------------------------------------------------
// requireRecentAuth runs BEFORE idempotent so a 403 is never stored against the key.
router.get('/:tenantId/main-admin', mainAdmin.get);
router.post('/:tenantId/main-admin/setup/resend', idem, validate(v.seatResend), mainAdmin.resendSetup);
router.post('/:tenantId/main-admin/suspend', idem, validate(v.seatSuspend), mainAdmin.suspend);
router.post('/:tenantId/main-admin/reactivate', mainAdmin.requireRecentAuth, idem, validate(v.seatRevisionOnly), mainAdmin.reactivate);
router.post('/:tenantId/main-admin/replacements', mainAdmin.requireRecentAuth, idem, validate(v.seatReplace), mainAdmin.replace);
router.post('/:tenantId/main-admin/replacements/:replacementId/cancel', idem, validate(v.seatRevisionOnly), mainAdmin.cancelReplacement);

module.exports = router;
