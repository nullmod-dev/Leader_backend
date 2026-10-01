/**
 * Detachment — the operational medical field unit; always inside exactly one
 * DetachmentGroup. The anchor of per-detachment capability scoping.
 *
 * Wire: { id, detachmentGroupId, name, region, mainCenter, notes?, status,
 *         imageUrl?, version, memberCount, weeklyShiftCount, coveragePercent }
 * The last three are derived on read (services/rollups.js).
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { RECORD_STATUS } = require('../config/constants');

const detachmentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentGroupId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    region: { type: String, default: '', trim: true },
    mainCenter: { type: String, default: '', trim: true },
    notes: { type: String, default: undefined },
    status: { type: String, enum: RECORD_STATUS, default: 'active' },
    imagePath: { type: String, default: undefined },
  },
  { timestamps: true, collection: 'detachments' },
);

detachmentSchema.plugin(basePlugin, { prefix: 'd', versioned: true, changeLog: 'detachment' });
detachmentSchema.index({ tenantId: 1, detachmentGroupId: 1 });
detachmentSchema.index({ tenantId: 1, status: 1 });

module.exports = mongoose.models.Detachment || mongoose.model('Detachment', detachmentSchema);
