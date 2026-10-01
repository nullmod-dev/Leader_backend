/**
 * /api/v1/platform/demo — Customer Demo policy and sessions (docs/api/customer-demo.md).
 * Super Admin only.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/demoValidators');
const ctrl = require('../../controllers/platform/demoController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/policy', ctrl.getPolicy);
router.patch('/policy', validate(v.policyPatch), idempotent({ required: true }), ctrl.patchPolicy);
router.get('/sessions', validate(v.sessionsQuery, 'query'), ctrl.listSessions);
router.post('/sessions/terminate-all', idempotent({ required: true }), ctrl.terminateAll);
router.post('/sessions/cleanup', idempotent(), ctrl.cleanup);
router.post('/sessions/:demoSessionId/terminate', idempotent({ required: true }), ctrl.terminate);

module.exports = router;
