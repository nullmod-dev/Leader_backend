/**
 * /api/v1/platform/reports — Point 13 report projections (read-only,
 * super_admin). Unknown query parameters are rejected (validateStrict).
 * See docs/api/platform-insights.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const v = require('../../validators/platformInsightsValidators');
const reports = require('../../controllers/platform/reportsController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/subscriptions', v.validateStrict(v.subscriptionsReport), reports.subscriptions);
router.get('/usage-limits', v.validateStrict(v.usageLimitsReport), reports.usageLimits);
router.get('/feature-availability', v.validateStrict(v.featureAvailabilityReport), reports.featureAvailability);
router.get('/platform-activity', v.validateStrict(v.platformActivityReport), reports.platformActivity);

module.exports = router;
