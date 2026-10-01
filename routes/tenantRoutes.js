/**
 * /api/v1/tenant — docs/api/tenant-administration.md, docs/api/tenant-analytics.md
 *
 *   GET   /tenant/organization                                  → OrganizationSnapshot
 *   GET   /tenant/features                                      → { features, readAt }
 *   GET   /tenant/simple-admins                     admin.manage → management snapshot
 *   POST  /tenant/simple-admin-invitations          admin.manage + Idempotency-Key → 201 invitation
 *   POST  /tenant/simple-admin-invitations/:id/cancel  admin.manage + Idempotency-Key → invitation
 *   POST  /tenant/simple-admin-invitations/:id/resend  admin.manage → invitation
 *   PATCH /tenant/simple-admins/:accountId/capabilities admin.manage → account
 *   POST  /tenant/simple-admins/:accountId/suspend      admin.manage → account
 *   POST  /tenant/simple-admins/:accountId/reactivate   admin.manage → account
 *   GET   /tenant/audit                              admin.manage → { items, nextCursor }
 *   GET   /tenant/analytics/dashboard                statistics_reports + stats.view
 *   GET   /tenant/analytics/detachments/:detachmentId  … + stats.view in that detachment
 *   GET   /tenant/analytics/workshops                … + workshops module
 *   GET   /tenant/analytics/inventory                … + inventory module
 */
const express = require('express');
const {
  tenantGuard,
  requireFeature,
  requireCap,
  requireCapIn,
  requireCapAnywhere,
  loadTenantDoc,
  fromParam,
} = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { Detachment } = require('../models');
const v = require('../validators/tenantAdminValidators');
const organization = require('../controllers/tenant/organizationController');
const simpleAdmins = require('../controllers/tenant/simpleAdminController');
const audit = require('../controllers/tenant/tenantAuditController');
const analytics = require('../controllers/tenant/tenantAnalyticsController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

// ---- organisation ------------------------------------------------------------------
router.get('/organization', organization.getOrganization);
router.get('/features', organization.getFeatures);

// ---- Simple Admin management -----------------------------------------------------------
const manage = requireCap('admin.manage');

router.get('/simple-admins', manage, simpleAdmins.list);
router.post('/simple-admin-invitations', manage, idempotent({ required: true }), validate(v.invitation), simpleAdmins.invite);
router.post(
  '/simple-admin-invitations/:invitationId/cancel',
  manage,
  idempotent({ required: true }),
  validate(v.expectedRevisionOnly),
  simpleAdmins.cancelInvitation,
);
router.post('/simple-admin-invitations/:invitationId/resend', manage, idempotent(), simpleAdmins.resendInvitation);
router.patch('/simple-admins/:accountId/capabilities', manage, idempotent(), validate(v.capabilitiesPatch), simpleAdmins.updateCapabilities);
router.post('/simple-admins/:accountId/suspend', manage, idempotent(), validate(v.suspend), simpleAdmins.suspend);
router.post('/simple-admins/:accountId/reactivate', manage, idempotent(), simpleAdmins.reactivate);

router.get('/audit', manage, audit.list);

// ---- analytics -------------------------------------------------------------------------------
const stats = [requireFeature('statistics_reports'), requireCapAnywhere('stats.view')];

router.get('/analytics/dashboard', stats, analytics.dashboard);
router.get(
  '/analytics/detachments/:detachmentId',
  stats,
  loadTenantDoc(Detachment, 'detachmentId', 'detachment'),
  requireCapIn('stats.view', fromParam('detachmentId')),
  analytics.detachment,
);
router.get('/analytics/workshops', stats, requireFeature('workshops'), analytics.workshops);
router.get('/analytics/inventory', stats, requireFeature('inventory'), analytics.inventory);

module.exports = router;
