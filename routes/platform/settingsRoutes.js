/**
 * /api/v1/platform/settings — platform policy values (super_admin only).
 * See docs/api/platform-configuration.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformConfigValidators');
const settings = require('../../controllers/platform/settingsController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/', settings.get);
router.patch('/', idempotent({ required: false }), validate(v.updateSettings), settings.update);

module.exports = router;
