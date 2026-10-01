/**
 * /api/v1/platform — Overview, Health and Security reads (super_admin only).
 * Mounted LAST on /platform, so the guard is attached per route: an unknown
 * /platform/* path still answers 404, not 401/403.
 * See docs/api/platform-insights.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const overview = require('../../controllers/platform/overviewController');
const health = require('../../controllers/platform/healthController');
const security = require('../../controllers/platform/securityController');

const router = express.Router({ mergeParams: true });

router.get('/overview', platformGuard, overview.overview);
router.get('/health', platformGuard, health.health);
router.get('/security-alerts', platformGuard, security.securityAlerts);

module.exports = router;
