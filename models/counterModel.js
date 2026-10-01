const mongoose = require('mongoose');

/** Named monotonic counters (per-tenant change-log sequence, etc.). */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false, collection: 'counters' },
);

counterSchema.statics.next = async function next(name, session) {
  const doc = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return doc.seq;
};

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);
