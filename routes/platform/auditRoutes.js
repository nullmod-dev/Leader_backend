/**
 * /api/v1/platform/audit — the platform audit stream (read-only, super_admin).
 * See docs/api/platform-insights.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformInsightsValidators');
const audit = require('../../controllers/platform/auditController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/', validate(v.auditList, 'query'), audit.list);
router.get('/:eventId', audit.get);

module.exports = router;
