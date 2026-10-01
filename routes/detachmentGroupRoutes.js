/**
 * /api/v1/detachment-groups — docs/api/detachments.md
 *
 *   GET    /                 list (visible groups, ?query)
 *   GET    /:groupId         one group (not visible → 404)
 *   POST   /                 create            detachment.create · limit detachment_groups
 *   PUT    /:groupId         full update       detachment.edit
 *   PATCH  /:groupId         partial update    detachment.edit
 *   DELETE /:groupId         cascade delete    detachment.archive
 */
const express = require('express');
const { tenantGuard, requireCap, loadTenantDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { DetachmentGroup } = require('../models');
const v = require('../validators/structureValidators');
const ctrl = require('../controllers/tenant/detachmentGroupController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

const loadGroup = loadTenantDoc(DetachmentGroup, 'groupId', 'group');

router.get('/', validate(v.groupList, 'query'), ctrl.list);
router.post('/', requireCap('detachment.create'), validate(v.groupCreate), idempotent(), ctrl.create);

router.get('/:groupId', ctrl.get);
router.put('/:groupId', requireCap('detachment.edit'), loadGroup, validate(v.groupPut), idempotent(), ctrl.update);
router.patch('/:groupId', requireCap('detachment.edit'), loadGroup, validate(v.groupPatch), idempotent(), ctrl.update);
router.delete('/:groupId', requireCap('detachment.archive'), loadGroup, idempotent(), ctrl.remove);

module.exports = router;
