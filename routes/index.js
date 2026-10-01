/**
 * /api/v1 route map. One file per module; see docs/api/*.md for each.
 *
 * Planes:
 *   identity  — /auth, /auth/customer-demo
 *   platform  — /platform/**            (super_admin only)
 *   tenant    — everything else        (main_admin / admin, tenant from token)
 *   public    — /app-version, /pricing (read), /dev (non-production)
 */
const express = require('express');

const router = express.Router();

// ---- identity -----------------------------------------------------------------
router.use('/auth/customer-demo', require('./customerDemoRoutes'));
router.use('/auth', require('./authRoutes'));

// ---- system ---------------------------------------------------------------------
router.use('/', require('./systemRoutes'));

// ---- platform (control plane) ------------------------------------------------------
router.use('/platform/tenants', require('./platform/tenantsRoutes'));
router.use('/platform/plans', require('./platform/plansRoutes'));
router.use('/platform/settings', require('./platform/settingsRoutes'));
router.use('/platform/admins', require('./platform/adminsRoutes'));
router.use('/platform/accounts', require('./platform/accountsRoutes'));
router.use('/platform/audit', require('./platform/auditRoutes'));
router.use('/platform/reports', require('./platform/reportsRoutes'));
router.use('/platform/analytics', require('./platform/analyticsRoutes'));
router.use('/platform/jobs', require('./platform/jobsRoutes'));
router.use('/platform/break-glass', require('./platform/breakGlassRoutes'));
router.use('/platform/demo', require('./platform/demoRoutes'));
router.use('/platform/commerce', require('./platform/commerceRoutes'));
router.use('/platform/billing', require('./platform/billingRoutes'));
router.use('/platform', require('./platform/insightsRoutes')); // overview, health, security-alerts

// ---- commerce (any full session) --------------------------------------------------
router.use('/pricing', require('./pricingRoutes'));
router.use('/billing', require('./billingRoutes'));

// ---- tenant plane ---------------------------------------------------------------------
router.use('/detachment-groups', require('./detachmentGroupRoutes'));
router.use('/detachments', require('./detachmentRoutes'));
router.use('/detachments/:detachmentId', require('./detachmentShiftRoutes'));
router.use('/members', require('./memberRoutes'));
router.use('/inventory-items', require('./inventoryRoutes'));
router.use('/shifts', require('./shiftRoutes'));
router.use('/shift-templates', require('./shiftTemplateRoutes'));
router.use('/workshops', require('./workshopRoutes'));
router.use('/workshop-participants', require('./workshopParticipantRoutes'));
router.use('/announcements', require('./announcementRoutes'));
router.use('/home', require('./homeRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/search', require('./searchRoutes'));
router.use('/settings', require('./settingsRoutes'));
router.use('/tenant', require('./tenantRoutes'));
router.use('/sync', require('./syncRoutes'));

module.exports = router;
