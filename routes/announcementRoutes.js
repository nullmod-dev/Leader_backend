/**
 * /api/v1/announcements — internal notices addressed to detachments.
 * Every route: tenantGuard → feature `announcements`.
 * Publish REQUIRES an Idempotency-Key. There is no delete.
 * See docs/api/announcements.md.
 */
const express = require('express');
const { tenantGuard, requireFeature, requireCapAnywhere } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const v = require('../validators/announcementValidators');
const announcements = require('../controllers/tenant/announcementController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard, requireFeature('announcements'));

router.get('/', validate(v.listQuery, 'query'), announcements.list);
router.post(
  '/',
  requireCapAnywhere('announcement.publish'),
  idempotent({ required: true }),
  validate(v.publish),
  announcements.publish,
);
router.get('/:announcementId', announcements.get);
router.post('/:announcementId/withdraw', idempotent(), announcements.withdraw);

module.exports = router;
