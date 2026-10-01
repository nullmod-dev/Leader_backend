/**
 * /api/v1/inventory-items — docs/api/inventory.md. Every route needs the
 * `inventory` module (403 feature_disabled otherwise).
 *
 *   POST   /                      create (+ opening inflow)   inventory.item.manage (body detachmentId)
 *   GET    /:itemId               one                          detachment.view
 *   PUT    /:itemId               edit (never the quantity)    inventory.item.manage
 *   PATCH  /:itemId               partial edit                 inventory.item.manage
 *   DELETE /:itemId               delete (+ movements, image)  inventory.item.manage
 *   GET    /:itemId/movements     ledger, newest first         detachment.view
 *   POST   /:itemId/movements     record a movement            inventory.adjust
 *   POST   /:itemId/image         upload (multipart)           inventory.item.manage
 *   DELETE /:itemId/image         remove                       inventory.item.manage
 *
 * Movements are append-only: there is no edit or delete endpoint for them.
 */
const express = require('express');
const { tenantGuard, requireFeature, requireCapIn, loadTenantDoc, fromDoc, fromBody } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const { InventoryItem } = require('../models');
const v = require('../validators/inventoryValidators');
const ctrl = require('../controllers/tenant/inventoryController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);
router.use(requireFeature('inventory'));

const load = loadTenantDoc(InventoryItem, 'itemId', 'item');
const capIn = (key) => requireCapIn(key, fromDoc('item'));

router.post('/', validate(v.create), requireCapIn('inventory.item.manage', fromBody('detachmentId')), idempotent(), ctrl.create);

router.get('/:itemId', load, capIn('detachment.view'), ctrl.get);
router.put('/:itemId', load, capIn('inventory.item.manage'), validate(v.put), idempotent(), ctrl.update);
router.patch('/:itemId', load, capIn('inventory.item.manage'), validate(v.patch), idempotent(), ctrl.update);
router.delete('/:itemId', load, capIn('inventory.item.manage'), idempotent(), ctrl.remove);

router.get('/:itemId/movements', load, capIn('detachment.view'), validate(v.movementsQuery, 'query'), ctrl.movements);
router.post('/:itemId/movements', load, capIn('inventory.adjust'), validate(v.movement), idempotent(), ctrl.addMovement);

router.post('/:itemId/image', load, capIn('inventory.item.manage'), imageUpload('image'), idempotent(), ctrl.setImage);
router.delete('/:itemId/image', load, capIn('inventory.item.manage'), idempotent(), ctrl.removeImage);

module.exports = router;
