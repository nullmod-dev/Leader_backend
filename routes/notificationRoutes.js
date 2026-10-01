/**
 * /api/v1/notifications — docs/api/home-notifications-search.md
 *
 *   GET /?detachmentId               { notifications: [AppNotification] }   detachment.view
 *   GET /unread-count?detachmentId   { count }                               detachment.view
 *   PUT /read     { ids }            { readIds }     (caller's full set)
 *   PUT /cleared  { ids }            { clearedIds }  (announcement history)
 *   GET /state                       { readIds, clearedIds }
 */
const express = require('express');
const { tenantGuard } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const v = require('../validators/structureValidators');
const { detachmentFromQuery } = require('../controllers/tenant/homeController');
const ctrl = require('../controllers/tenant/notificationController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

router.get('/', validate(v.detachmentQuery, 'query'), detachmentFromQuery, ctrl.feed);
router.get('/unread-count', validate(v.detachmentQuery, 'query'), detachmentFromQuery, ctrl.unreadCount);
router.get('/state', ctrl.state);
router.put('/read', validate(v.notificationIds), idempotent(), ctrl.markRead);
router.put('/cleared', validate(v.notificationIds), idempotent(), ctrl.markCleared);

module.exports = router;
