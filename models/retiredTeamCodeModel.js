/**
 * Retired Team Codes of deleted tenants. Stored only as a SHA-256 of the
 * canonical code: enough to refuse reuse, without keeping the code itself.
 */
const mongoose = require('mongoose');

const retiredTeamCodeSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // sha256(canonical code)
    retiredAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'retired_team_codes' },
);

module.exports = mongoose.models.RetiredTeamCode || mongoose.model('RetiredTeamCode', retiredTeamCodeSchema);
