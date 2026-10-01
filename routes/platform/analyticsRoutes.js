/**
 * /api/v1/platform/analytics — Super Admin dashboard charts (read-only,
 * super_admin). See docs/api/platform-insights.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformInsightsValidators');
const analytics = require('../../controllers/platform/analyticsController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/summary', validate(v.analyticsSummary, 'query'), analytics.summary);
router.get('/growth', validate(v.analyticsGrowth, 'query'), analytics.growth);
router.get('/tenants', validate(v.analyticsTenants, 'query'), analytics.tenants);
router.get('/tenants/:tenantId', validate(v.analyticsTenant, 'query'), analytics.tenant);

module.exports = router;
