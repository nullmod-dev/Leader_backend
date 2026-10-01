/**
 * Inventory — /api/v1/inventory-items (Flutter /detachment/:id storage tab and
 * the stock item sheet).
 *
 * `currentStock` / `minimum` are BASE units. Stock only ever moves through
 * `POST /:itemId/movements` (append-only ledger); an item edit never touches
 * the quantity. A movement is applied with ONE conditional atomic update
 * (`currentStock ≥ amount` for outflows) that also recomputes `level` and
 * bumps `version`, so two concurrent outflows can never drive stock negative.
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const { Detachment, InventoryItem, InventoryMovement, Counter, ChangeLog } = require('../../models');
const ser = require('../../services/serializers');
const storageService = require('../../services/storageService');
const { withTransaction } = require('../../services/txn');
const { assertVersion, saveVersioned } = require('../../services/versioning');

const OPENING_REASON = 'رصيد افتتاحي';

const packagingRequired = (field) =>
  new AppError('packaging_required', 422, 'Set units per strip and strips per carton before choosing this packaging.', {
    fields: { [field]: 'This packaging is not defined for the item.' },
  });

const assertBodyId = (bodyId, doc, field = 'id') => {
  if (bodyId !== undefined && bodyId !== String(doc._id)) {
    throw AppError.validation({ [field]: 'The body id must equal the id in the path.' });
  }
};

/** A throwaway item used only for the packaging helpers (supports / toBaseUnits). */
const packagingOf = (unitsPerStrip, stripsPerCarton) => new InventoryItem({ unitsPerStrip, stripsPerCarton });

/**
 * Change-log entry for an item updated with a raw atomic update (document
 * middleware — and so the base plugin's recorder — does not run for it).
 */
const recordUpsert = async (entityType, doc, session) => {
  const seq = await Counter.next(`changelog:${doc.tenantId}`, session);
  await ChangeLog.create(
    [{ tenantId: doc.tenantId, seq, entityType, entityId: String(doc._id), op: 'upsert', version: doc.version, detachmentId: doc.detachmentId }],
    { session },
  );
};

/** Aggregation-pipeline update: stock += delta, version + 1, level recomputed from the NEW stock. */
const applyDelta = (delta) => [
  { $set: { currentStock: { $add: ['$currentStock', delta] }, version: { $add: ['$version', 1] } } },
  {
    $set: {
      level: {
        $switch: {
          branches: [
            { case: { $lte: ['$currentStock', 0] }, then: 'empty' },
            { case: { $lt: ['$currentStock', '$minimum'] }, then: 'low' },
          ],
          default: 'ok',
        },
      },
    },
  },
];

// POST /inventory-items
exports.create = catchAsync(async (req, res) => {
  const b = req.body;
  const det = await Detachment.findOne({ _id: b.detachmentId, tenantId: req.tenantId });
  if (!det) throw AppError.notFound('detachment');

  const pack = packagingOf(b.unitsPerStrip, b.stripsPerCarton);
  if (!pack.supports(b.openingUnit)) throw packagingRequired('openingUnit');
  const preferredUnit = b.preferredUnit || b.openingUnit;
  if (!pack.supports(preferredUnit)) throw packagingRequired('preferredUnit');
  const openingBase = pack.toBaseUnits(b.openingStock, b.openingUnit);
  const account = req.auth.account;

  const item = await withTransaction(async (session) => {
    const [created] = await InventoryItem.create(
      [
        {
          tenantId: req.tenantId,
          detachmentId: String(det._id),
          name: b.name,
          unit: b.unit,
          currentStock: openingBase,
          minimum: b.minimum,
          expiresOn: b.expiresOn || undefined,
          unitsPerStrip: b.unitsPerStrip,
          stripsPerCarton: b.stripsPerCarton,
          preferredUnit,
        },
      ],
      { session },
    );
    if (openingBase > 0) {
      await InventoryMovement.create(
        [
          {
            tenantId: req.tenantId,
            detachmentId: String(det._id),
            itemId: String(created._id),
            itemName: created.name,
            direction: 'inflow',
            quantity: b.openingStock,
            packagingUnit: b.openingUnit,
            convertedBaseUnitQuantity: openingBase,
            reason: OPENING_REASON,
            source: 'inventory_setup',
            performedBy: String(account._id),
            performedByName: account.name || '',
            stockBefore: 0,
            stockAfter: openingBase,
            at: new Date(),
          },
        ],
        { session },
      );
    }
    return created;
  });
  res.status(201).json(ser.inventoryItem(item));
});

// GET /inventory-items/:itemId
exports.get = catchAsync(async (req, res) => {
  res.json(ser.inventoryItem(req.docs.item));
});

// PUT | PATCH /inventory-items/:itemId — the quantity is NOT editable here
exports.update = catchAsync(async (req, res) => {
  const item = req.docs.item;
  const b = req.body;
  assertBodyId(b.id, item);
  assertVersion(item, b.version, ser.inventoryItem);

  const unitsPerStrip = b.unitsPerStrip ?? item.unitsPerStrip;
  const stripsPerCarton = b.stripsPerCarton ?? item.stripsPerCarton;
  const preferredUnit = b.preferredUnit ?? item.preferredUnit;
  if (!packagingOf(unitsPerStrip, stripsPerCarton).supports(preferredUnit)) throw packagingRequired('preferredUnit');

  if (b.name !== undefined) item.name = b.name;
  if (b.unit !== undefined) item.unit = b.unit;
  if (b.minimum !== undefined) item.minimum = b.minimum;
  item.unitsPerStrip = unitsPerStrip;
  item.stripsPerCarton = stripsPerCarton;
  item.preferredUnit = preferredUnit;
  if (b.expiresOn !== undefined) item.expiresOn = b.expiresOn || undefined;

  await saveVersioned(item, ser.inventoryItem); // level is recomputed by the model
  res.json(ser.inventoryItem(item));
});

// DELETE /inventory-items/:itemId — the item, its movements, its image
exports.remove = catchAsync(async (req, res) => {
  const item = req.docs.item;
  const itemId = String(item._id);
  await withTransaction(async (session) => {
    const doc = await InventoryItem.findOne({ _id: itemId, tenantId: req.tenantId }).session(session || null);
    if (doc) await doc.deleteOne();
    await InventoryMovement.deleteMany({ tenantId: req.tenantId, itemId }, { session });
  });
  await storageService.removeOwnerFiles('inventory_item', itemId);
  res.status(204).end();
});

// GET /inventory-items/:itemId/movements?limit=50 — newest first
exports.movements = catchAsync(async (req, res) => {
  const movements = await InventoryMovement.find({ tenantId: req.tenantId, itemId: String(req.docs.item._id) })
    .sort({ at: -1, _id: -1 })
    .limit(req.query.limit || 50);
  res.json(movements.map(ser.movement));
});

// POST /inventory-items/:itemId/movements — 200 { ...InventoryItem, lastMovement }
exports.addMovement = catchAsync(async (req, res) => {
  const item = req.docs.item;
  const b = req.body;
  assertBodyId(b.itemId, item, 'itemId');
  if (!item.supports(b.packagingUnit)) {
    throw new AppError('packaging_unavailable', 422, 'This item is not defined in that packaging.', {
      fields: { packagingUnit: 'This packaging is not defined for the item.' },
    });
  }
  const amount = item.toBaseUnits(b.quantity, b.packagingUnit);
  const delta = b.direction === 'inflow' ? amount : -amount;
  const account = req.auth.account;
  const itemId = String(item._id);

  const { updated, movement } = await withTransaction(async (session) => {
    const filter = { _id: itemId, tenantId: req.tenantId };
    if (b.direction === 'outflow') filter.currentStock = { $gte: amount };
    const after = await InventoryItem.findOneAndUpdate(filter, applyDelta(delta), { new: true, session });
    if (!after) {
      const current = await InventoryItem.findOne({ _id: itemId, tenantId: req.tenantId }).session(session || null);
      if (!current) throw AppError.notFound('inventory item');
      throw new AppError('insufficient_stock', 409, 'The requested quantity is larger than the current stock.', {
        currentStock: current.currentStock,
        requested: amount,
      });
    }
    await recordUpsert('inventory_item', after, session);
    const [mv] = await InventoryMovement.create(
      [
        {
          tenantId: req.tenantId,
          detachmentId: after.detachmentId,
          itemId,
          itemName: after.name,
          direction: b.direction,
          quantity: b.quantity,
          packagingUnit: b.packagingUnit,
          convertedBaseUnitQuantity: amount,
          reason: b.reason,
          source: b.source || 'mobile_app',
          performedBy: String(account._id),
          performedByName: account.name || '',
          stockBefore: after.currentStock - delta,
          stockAfter: after.currentStock,
          at: new Date(),
        },
      ],
      { session },
    );
    return { updated: after, movement: mv };
  });

  res.json({ ...ser.inventoryItem(updated), lastMovement: ser.movement(movement) });
});

// POST /inventory-items/:itemId/image (multipart "image")
exports.setImage = catchAsync(async (req, res) => {
  const item = req.docs.item;
  let saved;
  try {
    saved = await storageService.saveImage(req.file.buffer, 'inventory', {
      ownerType: 'inventory_item',
      ownerId: String(item._id),
      tenantId: req.tenantId,
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.validation({ image: 'The file is not a readable image.' });
  }
  const previous = item.imagePath;
  item.imagePath = saved.path;
  try {
    await saveVersioned(item, ser.inventoryItem);
  } catch (e) {
    await storageService.removeFile(saved.path);
    throw e;
  }
  if (previous) await storageService.removeFile(previous);
  res.json(ser.inventoryItem(item));
});

// DELETE /inventory-items/:itemId/image
exports.removeImage = catchAsync(async (req, res) => {
  const item = req.docs.item;
  const previous = item.imagePath;
  if (previous) {
    item.imagePath = undefined;
    await saveVersioned(item, ser.inventoryItem);
    await storageService.removeFile(previous);
  }
  res.json(ser.inventoryItem(item));
});
