/**
 * /api/v1/platform/break-glass — emergency access (docs/api/break-glass.md).
 * Super Admin only. Grants are bound to the calling session.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const { VIEW_RESOURCES } = require('../../services/breakGlassService');
const v = require('../../validators/breakGlassValidators');
const ctrl = require('../../controllers/platform/breakGlassController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/current', ctrl.current);
router.get('/grants', validate(v.listQuery, 'query'), ctrl.list);
router.post('/grants', validate(v.activate), idempotent({ required: true }), ctrl.activate);
router.post('/grants/:grantId/end', validate(v.revisionCommand), idempotent({ required: true }), ctrl.end);
router.post('/grants/:grantId/revoke', validate(v.revisionCommand), idempotent({ required: true }), ctrl.revoke);

// Grant-scoped, READ-ONLY tenant viewer. GET only — there is no write path.
VIEW_RESOURCES.forEach((resource) => {
  router.get(`/view/${resource}`, validate(v.viewQuery, 'query'), ctrl.view(resource));
});

module.exports = router;
