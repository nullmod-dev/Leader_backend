/**
 * /api/v1/detachments — docs/api/detachments.md
 *
 *   GET    /                                   list (visible only; ?detachmentGroupId&filter&query)
 *   POST   /                                   create              detachment.create · limit detachments
 *   GET    /:detachmentId                      one                 detachment.view
 *   PUT    /:detachmentId                      full update         detachment.edit (+ detachment.archive to change status)
 *   PATCH  /:detachmentId                      partial update      idem
 *   POST   /:detachmentId/archive | /restore   lifecycle           detachment.archive (restore: limit detachments)
 *   DELETE /:detachmentId                      cascade delete      detachment.archive
 *   GET    /:detachmentId/stats                daily series        [statistics_reports] stats.view
 *   POST   /:detachmentId/image                upload (multipart)  detachment.edit
 *   DELETE /:detachmentId/image                remove              detachment.edit
 *   GET    /:detachmentId/members              roster              member.view
 *   GET    /:detachmentId/inventory-items      store               [inventory] detachment.view
 *   GET    /:detachmentId/inventory-movements  ledger              [inventory] detachment.view
 *
 * /:detachmentId/shifts* and /shift-templates live in detachmentShiftRoutes.js.
 * A detachment of another tenant is always 404 (loaded before the capability check).
 */
const express = require('express');
const { tenantGuard, requireFeature, requireCap, requireCapIn, loadTenantDoc, fromDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const { Detachment } = require('../models');
const v = require('../validators/structureValidators');
const inv = require('../validators/inventoryValidators');
const ctrl = require('../controllers/tenant/detachmentController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

const load = loadTenantDoc(Detachment, 'detachmentId', 'detachment');
const capIn = (key) => requireCapIn(key, fromDoc('detachment', '_id'));

router.get('/', validate(v.detachmentList, 'query'), ctrl.list);
router.post('/', requireCap('detachment.create'), validate(v.detachmentCreate), idempotent(), ctrl.create);

router.get('/:detachmentId', load, capIn('detachment.view'), ctrl.get);
router.put('/:detachmentId', load, capIn('detachment.edit'), validate(v.detachmentPut), idempotent(), ctrl.update);
router.patch('/:detachmentId', load, capIn('detachment.edit'), validate(v.detachmentPatch), idempotent(), ctrl.update);
router.delete('/:detachmentId', load, capIn('detachment.archive'), idempotent(), ctrl.remove);

router.post('/:detachmentId/archive', load, capIn('detachment.archive'), validate(v.lifecycleCommand), idempotent(), ctrl.archive);
router.post('/:detachmentId/restore', load, capIn('detachment.archive'), validate(v.lifecycleCommand), idempotent(), ctrl.restore);

router.get('/:detachmentId/stats', requireFeature('statistics_reports'), load, capIn('stats.view'), validate(v.statsQuery, 'query'), ctrl.stats);

router.post('/:detachmentId/image', load, capIn('detachment.edit'), imageUpload('image'), idempotent(), ctrl.setImage);
router.delete('/:detachmentId/image', load, capIn('detachment.edit'), idempotent(), ctrl.removeImage);

router.get('/:detachmentId/members', load, capIn('member.view'), validate(v.rosterQuery, 'query'), ctrl.members);

router.get('/:detachmentId/inventory-items', requireFeature('inventory'), load, capIn('detachment.view'), ctrl.inventoryItems);
router.get(
  '/:detachmentId/inventory-movements',
  requireFeature('inventory'),
  load,
  capIn('detachment.view'),
  validate(inv.movementsQuery, 'query'),
  ctrl.inventoryMovements,
);

module.exports = router;
