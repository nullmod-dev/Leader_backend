/**
 * Cascade delete for detachments (and the groups that hold them).
 *
 * A detachment cannot exist unfiled, and nothing inside it survives it:
 *
 *   team members (+ photos) · shifts · shift templates · inventory items
 *   (+ images) · inventory movements · the detachment image
 *   announcements: the id is pulled from `detachmentIds`; an announcement
 *                  left with no target is deleted
 *   grants:        the id is removed from every `capabilities.scoped` map of
 *                  the tenant's accounts (and pending Simple Admin invitations)
 *
 * Versioned tenant documents go through `doc.deleteOne()` so the change log
 * records a `delete` for `GET /sync/pull`. Movements (append-only, possibly
 * thousands) go through one `deleteMany`.
 *
 * Database work runs inside ONE transaction; image files are removed from disk
 * only after it commits (a rolled-back delete must not lose files).
 *
 * Shift / workshop lines elsewhere that reference a deleted member keep the id
 * and render as a missing member (serializers.missingMember).
 */
const {
  Detachment,
  DetachmentGroup,
  TeamMember,
  Shift,
  ShiftTemplate,
  InventoryItem,
  InventoryMovement,
  Announcement,
  Account,
  Authorization,
} = require('../models');
const storageService = require('./storageService');
const { withTransaction } = require('./txn');

const inSession = (query, session) => (session ? query.session(session) : query);

/** Delete each document one by one (document middleware → change log). */
const deleteDocs = async (docs) => {
  for (const doc of docs) await doc.deleteOne();
  return docs.length;
};

/**
 * Delete detachments and everything inside them. Database only — returns the
 * file owners whose images must be purged once the transaction commits.
 *
 * @param {string}   tenantId
 * @param {string[]} detachmentIds
 * @param {object}   [opts]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<{ files: Array<[string, string]>, deleted: object }>}
 */
const deleteDetachments = async (tenantId, detachmentIds, { session } = {}) => {
  const ids = [...new Set((detachmentIds || []).map(String))];
  const deleted = { detachments: 0, members: 0, shifts: 0, shiftTemplates: 0, inventoryItems: 0, inventoryMovements: 0, announcements: 0 };
  const files = [];
  if (!ids.length) return { files, deleted };

  const scope = { tenantId, detachmentId: { $in: ids } };

  const members = await inSession(TeamMember.find(scope), session);
  members.forEach((m) => files.push(['member', String(m._id)]));
  deleted.members = await deleteDocs(members);

  deleted.shifts = await deleteDocs(await inSession(Shift.find(scope), session));
  deleted.shiftTemplates = await deleteDocs(await inSession(ShiftTemplate.find(scope), session));

  const items = await inSession(InventoryItem.find(scope), session);
  items.forEach((i) => files.push(['inventory_item', String(i._id)]));
  deleted.inventoryItems = await deleteDocs(items);
  deleted.inventoryMovements = (await InventoryMovement.deleteMany(scope, { session })).deletedCount || 0;

  const announcements = await inSession(Announcement.find({ tenantId, detachmentIds: { $in: ids } }), session);
  for (const a of announcements) {
    const remaining = (a.detachmentIds || []).filter((d) => !ids.includes(String(d)));
    if (!remaining.length) {
      await a.deleteOne();
      deleted.announcements += 1;
    } else {
      a.detachmentIds = remaining;
      await a.save();
    }
  }

  // Scoped grants: the keys are the detachment ids themselves.
  const unset = Object.fromEntries(ids.map((id) => [`capabilities.scoped.${id}`, '']));
  await Account.updateMany({ saasTenantId: tenantId }, { $unset: unset }, { session });
  await Authorization.updateMany({ tenantId, status: 'pending' }, { $unset: unset }, { session });

  const detachments = await inSession(Detachment.find({ tenantId, _id: { $in: ids } }), session);
  detachments.forEach((d) => files.push(['detachment', String(d._id)]));
  deleted.detachments = await deleteDocs(detachments);

  return { files, deleted };
};

/** Remove the image files of deleted owners (after commit; missing files are ignored). */
const purgeFiles = async (files) => {
  for (const [ownerType, ownerId] of files || []) {
    try {
      await storageService.removeOwnerFiles(ownerType, ownerId);
    } catch (e) {
      /* a file that cannot be removed must not fail a committed delete */
    }
  }
};

/** Delete ONE detachment with its whole contents. Returns the deleted counts. */
const deleteDetachment = async (tenantId, detachmentId) => {
  const result = await withTransaction((session) => deleteDetachments(tenantId, [detachmentId], { session }));
  await purgeFiles(result.files);
  return result.deleted;
};

/**
 * Delete a group, every detachment inside it (any status) and their contents.
 * The detachment list is read INSIDE the transaction so a detachment created
 * concurrently cannot be left orphaned.
 */
const deleteGroup = async (tenantId, groupId) => {
  const result = await withTransaction(async (session) => {
    const group = await inSession(DetachmentGroup.findOne({ _id: groupId, tenantId }), session);
    const dets = await inSession(Detachment.find({ tenantId, detachmentGroupId: String(groupId) }).select('_id'), session);
    const out = await deleteDetachments(
      tenantId,
      dets.map((d) => String(d._id)),
      { session },
    );
    if (group) await group.deleteOne();
    return out;
  });
  await purgeFiles(result.files);
  return result.deleted;
};

module.exports = { deleteDetachments, purgeFiles, deleteDetachment, deleteGroup };
