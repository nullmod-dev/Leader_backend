/**
 * /api/v1/platform/plans — SaaS plan catalogue (super_admin only).
 * See docs/api/platform-configuration.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformConfigValidators');
const plans = require('../../controllers/platform/plansController');

const router = express.Router({ mergeParams: true });
const idem = idempotent({ required: false });

router.use(platformGuard);

router.get('/', plans.list);
router.post('/', idem, validate(v.createPlan), plans.create);
router.patch('/:planId', idem, validate(v.updatePlan), plans.update);
router.delete('/:planId', idem, plans.remove);

module.exports = router;
