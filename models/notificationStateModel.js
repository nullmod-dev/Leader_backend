/**
 * Per-ACCOUNT notification state: read ids (incl. the client's own
 * syncConflict/syncFailed ids — unknown ids are stored, never rejected) and the
 * cleared announcement-history set.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const notificationStateSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    readIds: { type: [String], default: [] },
    clearedIds: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'notification_states' },
);

notificationStateSchema.plugin(basePlugin, { prefix: 'ns', tenantScoped: true });

module.exports = mongoose.models.NotificationState || mongoose.model('NotificationState', notificationStateSchema);
