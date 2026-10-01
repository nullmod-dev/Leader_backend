/**
 * /api/v1/home — docs/api/home-notifications-search.md
 *
 *   GET /summary?detachmentId   HomeSummary for one detachment   detachment.view (404 / 403 distinct)
 *   GET /overview               org aggregate over visible active detachments
 */
const express = require('express');
const { tenantGuard } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const v = require('../validators/structureValidators');
const ctrl = require('../controllers/tenant/homeController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

router.get('/summary', validate(v.detachmentQuery, 'query'), ctrl.detachmentFromQuery, ctrl.summary);
router.get('/overview', ctrl.overview);

module.exports = router;
