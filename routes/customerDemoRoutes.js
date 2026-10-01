/**
 * /api/v1/auth/customer-demo — the self-service Customer Demo (docs/api/customer-demo.md).
 * A demo session is refused by every tenant and platform endpoint.
 */
const express = require('express');
const { accountGuard } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { demoStartLimiter } = require('../middlewares/rateLimit');
const v = require('../validators/demoValidators');
const ctrl = require('../controllers/customerDemoController');

const router = express.Router({ mergeParams: true });

router.post('/start', demoStartLimiter, validate(v.start), ctrl.start);
router.get('/session', accountGuard, ctrl.session);
router.post('/end', accountGuard, ctrl.end);

module.exports = router;
