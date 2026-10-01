/**
 * Announcement — an internal operational notice between ADMINISTRATORS,
 * addressed to one or more detachments. Plain text only (5–500 chars), no
 * attachment, no image, never a wildcard target, always a finite expiry.
 * Withdraw, never delete: the Notifications Center entry is history.
 *
 * Wire: { id, text, detachmentIds, placements, publishedAt, expiresAt, status,
 *         authorName? }
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { ANNOUNCEMENT_PLACEMENTS, ANNOUNCEMENT_STATUS } = require('../config/constants');

const announcementSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    text: { type: String, required: true },
    detachmentIds: { type: [String], required: true },
    placements: { type: [{ type: String, enum: ANNOUNCEMENT_PLACEMENTS }], default: ['notifications'] },
    publishedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ANNOUNCEMENT_STATUS, default: 'active' },
    authorId: { type: String },
    authorName: { type: String },
    withdrawnAt: Date,
  },
  { timestamps: true, collection: 'announcements' },
);

announcementSchema.plugin(basePlugin, { prefix: 'a', versioned: true, changeLog: 'announcement' });
announcementSchema.index({ tenantId: 1, detachmentIds: 1, publishedAt: -1 });

announcementSchema.set('toJSON', {
  transform(doc, ret) {
    const out = {
      id: ret._id,
      text: ret.text,
      detachmentIds: ret.detachmentIds,
      placements: ret.placements.includes('notifications') ? ret.placements : ['notifications', ...ret.placements],
      publishedAt: ret.publishedAt,
      expiresAt: ret.expiresAt,
      status: ret.status,
      version: ret.version,
    };
    if (ret.authorName) out.authorName = ret.authorName;
    return out;
  },
});

module.exports = mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);
