/**
 * Inventory. `currentStock` and `minimum` are in BASE units (individual
 * pieces). A movement may be recorded in strips or cartons and is converted
 * with the item's packaging (`convertedBaseUnitQuantity`).
 *
 * Wire — InventoryItem (inventory_models.dart):
 *   { id, detachmentId, name, unit, currentStock, minimum, expiresOn?:
 *     "YYYY-MM-DD", level: ok|low|empty, unitsPerStrip, stripsPerCarton,
 *     preferredUnit: individual|strip|carton, imageUrl?, version }
 *   level: stock == 0 → empty; stock < minimum → low; else ok.
 *
 * Wire — InventoryMovement: append-only ledger, NEVER versioned, never edited.
 *   { id, itemId, itemName, direction: inflow|outflow, quantity,
 *     packagingUnit, convertedBaseUnitQuantity, reason, source, performedBy,
 *     performedByName, stockBefore, stockAfter, at }
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { INVENTORY_LEVELS, PACKAGING_UNITS, MOVEMENT_DIRECTIONS } = require('../config/constants');

const levelOf = (stock, minimum) => {
  if (stock <= 0) return 'empty';
  if (stock < minimum) return 'low';
  return 'ok';
};

const inventoryItemSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    currentStock: { type: Number, default: 0, min: 0 },
    minimum: { type: Number, default: 0, min: 0 },
    expiresOn: { type: String, default: undefined }, // YYYY-MM-DD
    level: { type: String, enum: INVENTORY_LEVELS, default: 'empty' },
    unitsPerStrip: { type: Number, default: 1, min: 1 },
    stripsPerCarton: { type: Number, default: 1, min: 1 },
    preferredUnit: { type: String, enum: PACKAGING_UNITS, default: 'individual' },
    imagePath: { type: String, default: undefined },
  },
  { timestamps: true, collection: 'inventory_items' },
);

inventoryItemSchema.plugin(basePlugin, { prefix: 'i', versioned: true, changeLog: 'inventory_item' });
inventoryItemSchema.index({ tenantId: 1, detachmentId: 1 });

inventoryItemSchema.pre('validate', function recomputeLevel(next) {
  this.level = levelOf(this.currentStock, this.minimum);
  next();
});

inventoryItemSchema.methods.supports = function supports(unit) {
  if (unit === 'individual') return true;
  if (unit === 'strip') return this.unitsPerStrip > 1;
  if (unit === 'carton') return this.unitsPerStrip > 1 && this.stripsPerCarton > 1;
  return false;
};

inventoryItemSchema.methods.toBaseUnits = function toBaseUnits(quantity, unit) {
  if (unit === 'strip') return quantity * this.unitsPerStrip;
  if (unit === 'carton') return quantity * this.unitsPerStrip * this.stripsPerCarton;
  return quantity;
};

const inventoryMovementSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentId: { type: String, required: true },
    itemId: { type: String, required: true },
    itemName: String,
    direction: { type: String, enum: MOVEMENT_DIRECTIONS, required: true },
    quantity: { type: Number, required: true, min: 1 },
    packagingUnit: { type: String, enum: PACKAGING_UNITS, default: 'individual' },
    convertedBaseUnitQuantity: { type: Number, required: true, min: 1 },
    reason: { type: String, default: '' },
    source: { type: String, default: 'mobile_app' },
    performedBy: String,
    performedByName: String,
    stockBefore: Number,
    stockAfter: Number,
    at: { type: Date, default: Date.now },
  },
  { collection: 'inventory_movements' },
);

inventoryMovementSchema.plugin(basePlugin, { prefix: 'mv', changeLog: 'inventory_movement' });
inventoryMovementSchema.index({ tenantId: 1, itemId: 1, at: -1 });
inventoryMovementSchema.index({ tenantId: 1, detachmentId: 1, at: -1 });

module.exports = {
  InventoryItem: mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema),
  InventoryMovement: mongoose.models.InventoryMovement || mongoose.model('InventoryMovement', inventoryMovementSchema),
  levelOf,
};
