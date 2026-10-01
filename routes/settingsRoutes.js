/**
 * /api/v1/settings — docs/api/tenant-administration.md
 *
 *   GET    /settings/notifications         any full session → NotificationPrefs
 *   PUT    /settings/notifications         any full session → NotificationPrefs
 *   GET    /settings/organization          tenant           → OrgInfo
 *   PATCH  /settings/organization          org.edit         → OrgInfo
 *   POST   /settings/organization/logo     org.edit (multipart `image`) → OrgInfo
 *   DELETE /settings/organization/logo     org.edit         → OrgInfo
 */
const express = require('express');
const { accountGuard, tenantGuard, requireCap } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const v = require('../validators/tenantAdminValidators');
const ctrl = require('../controllers/tenant/settingsController');

const router = express.Router({ mergeParams: true });

router.get('/notifications', accountGuard, ctrl.getNotifications);
router.put('/notifications', accountGuard, idempotent(), validate(v.notificationPrefs), ctrl.putNotifications);

router.get('/organization', tenantGuard, ctrl.getOrganization);
router.patch('/organization', tenantGuard, requireCap('org.edit'), idempotent(), validate(v.organizationPatch), ctrl.patchOrganization);
router.post('/organization/logo', tenantGuard, requireCap('org.edit'), imageUpload('image'), ctrl.uploadLogo);
router.delete('/organization/logo', tenantGuard, requireCap('org.edit'), ctrl.deleteLogo);

module.exports = router;
