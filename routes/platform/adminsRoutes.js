/**
 * /api/v1/platform/admins — Super Admin accounts (super_admin only).
 * See docs/api/platform-configuration.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformConfigValidators');
const admins = require('../../controllers/platform/adminsController');

const router = express.Router({ mergeParams: true });
const idem = idempotent({ required: false });

router.use(platformGuard);

router.get('/', admins.list);
router.post('/', idem, validate(v.createAdmin), admins.create);
router.post('/:accountId/suspend', idem, validate(v.suspendAdmin), admins.suspend);
router.post('/:accountId/reactivate', idem, admins.reactivate);

module.exports = router;
