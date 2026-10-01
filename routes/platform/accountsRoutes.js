/**
 * /api/v1/platform/accounts — cross-tenant account lookup (super_admin only).
 * See docs/api/platform-configuration.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const { validate } = require('../../middlewares/validate');
const v = require('../../validators/platformConfigValidators');
const accounts = require('../../controllers/platform/accountsController');

const router = express.Router({ mergeParams: true });

router.use(platformGuard);

router.get('/', validate(v.listAccountsQuery, 'query'), accounts.list);
router.get('/:accountId', accounts.get);
router.post('/:accountId/sign-out-all', idempotent({ required: false }), accounts.signOutAll);

module.exports = router;
