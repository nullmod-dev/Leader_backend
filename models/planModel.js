/**
 * SaaS plan — a reusable limit definition (`mtm_core` / `mtm_standard` /
 * `mtm_advanced`). Not copied into tenants; `effective = override ?? plan default`.
 * Plans carry NO price: prices are the commerce billing options.
 */
const mongoose = require('mongoose');
const { PLAN_LIMIT_KEYS } = require('../config/constants');

const limitsShape = {};
PLAN_LIMIT_KEYS.forEach((k) => {
  limitsShape[k] = { type: Number, required: true, min: 0 };
});

const planSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // wire id, e.g. mtm_standard
    name: { type: String, required: true },
    description: { type: String, default: '' },
    recommended: { type: Boolean, default: false },
    selectable: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    defaultLimits: { type: new mongoose.Schema(limitsShape, { _id: false }), required: true },
  },
  { timestamps: true, versionKey: false, collection: 'plans' },
);

planSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.order;
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  },
});

module.exports = mongoose.models.Plan || mongoose.model('Plan', planSchema);
