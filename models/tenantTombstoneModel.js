/**
 * The ONLY record kept after final tenant deletion. No Team Code, Main Admin,
 * email, subscription, limits, features, reason, usage, counts or operational
 * data — restricted to the control plane.
 */
const mongoose = require('mongoose');

const tombstoneSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // = tenantId
    displayNameSnapshot: { type: String, required: true },
    status: { type: String, default: 'deleted' },
    deletedAt: { type: Date, required: true },
    lifecycleVersion: { type: Number, required: true },
    historyReference: { type: String, required: true },
  },
  { versionKey: false, collection: 'tenant_tombstones' },
);

tombstoneSchema.set('toJSON', {
  transform(doc, ret) {
    ret.tenantId = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.models.TenantTombstone || mongoose.model('TenantTombstone', tombstoneSchema);
