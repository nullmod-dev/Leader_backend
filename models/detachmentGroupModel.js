/**
 * DetachmentGroup — a local grouping of detachments INSIDE one tenant (one
 * branch / operating area). Carries no billing or isolation meaning.
 *
 * Wire: { id, name, createdAt, notes?, status, version,
 *         detachmentCount, memberCount, coveragePercent }   ← last three are
 * derived roll-ups computed on read (services/rollups.js), never stored.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { RECORD_STATUS } = require('../config/constants');

const detachmentGroupSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    notes: { type: String, default: undefined },
    status: { type: String, enum: RECORD_STATUS, default: 'active' },
  },
  { timestamps: true, collection: 'detachment_groups' },
);

detachmentGroupSchema.plugin(basePlugin, { prefix: 'g', versioned: true, changeLog: 'detachment_group' });
detachmentGroupSchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });

detachmentGroupSchema.pre('validate', function setKey(next) {
  const { nameKey } = require('../utils/normalize');
  if (this.name) this.nameKey = nameKey(this.name);
  next();
});

module.exports = mongoose.models.DetachmentGroup || mongoose.model('DetachmentGroup', detachmentGroupSchema);
