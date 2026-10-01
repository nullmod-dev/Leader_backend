/**
 * Detachment groups — /api/v1/detachment-groups (Flutter /detachment-groups).
 *
 * Visibility: a caller sees a group when it sees every detachment
 * (`visibleDetachmentIds` = null) or when the group holds at least one
 * detachment it can see. Roll-ups are recomputed on every read.
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { DetachmentGroup, Detachment } = require('../../models');
const ser = require('../../services/serializers');
const rollups = require('../../services/rollups');
const usageService = require('../../services/usageService');
const cascade = require('../../services/detachmentCascade');
const { assertVersion, saveVersioned } = require('../../services/versioning');
const { searchFold, nameKey } = require('../../utils/normalize');

/** Set of group ids the caller may see, or null for all. */
const visibleGroupIds = async (req) => {
  const visible = caps.visibleDetachmentIds(req.grant);
  if (visible === null) return null;
  if (!visible.length) return new Set();
  const dets = await Detachment.find({ tenantId: req.tenantId, _id: { $in: visible } })
    .select('detachmentGroupId')
    .lean();
  return new Set(dets.map((d) => d.detachmentGroupId));
};

const render = async (req, groups) => {
  const roll = await rollups.groupRollups(
    req.tenantId,
    groups.map((g) => String(g._id)),
    req.tz,
  );
  return groups.map((g) => ser.detachmentGroup(g, roll.get(String(g._id))));
};

const renderOne = async (req, group) => (await render(req, [group]))[0];

const nameConflict = () =>
  AppError.conflict('Another detachment group already uses this name.', { fields: { name: 'This name is already in use.' } });

const assertNameFree = async (tenantId, name, exceptId) => {
  const q = { tenantId, nameKey: nameKey(name) };
  if (exceptId) q._id = { $ne: String(exceptId) };
  if (await DetachmentGroup.exists(q)) throw nameConflict();
};

const assertBodyId = (bodyId, doc) => {
  if (bodyId !== undefined && bodyId !== String(doc._id)) {
    throw AppError.validation({ id: 'The body id must equal the id in the path.' });
  }
};

/** Save that maps a unique-index race on the name to `conflict`. */
const save = async (group, serialize) => {
  try {
    await saveVersioned(group, serialize);
  } catch (e) {
    if (e && e.code === 11000) throw nameConflict();
    throw e;
  }
};

// GET /detachment-groups?query=
exports.list = catchAsync(async (req, res) => {
  const visible = await visibleGroupIds(req);
  let groups = await DetachmentGroup.find({ tenantId: req.tenantId }).sort({ createdAt: 1, _id: 1 });
  if (visible !== null) groups = groups.filter((g) => visible.has(String(g._id)));
  const q = searchFold(req.query.query || '');
  if (q) groups = groups.filter((g) => searchFold(g.name).includes(q) || (g.notes && searchFold(g.notes).includes(q)));
  res.json(await render(req, groups));
});

// GET /detachment-groups/:groupId — not in tenant OR not visible → 404
exports.get = catchAsync(async (req, res) => {
  const group = await DetachmentGroup.findOne({ _id: req.params.groupId, tenantId: req.tenantId });
  const visible = group ? await visibleGroupIds(req) : null;
  if (!group || (visible !== null && !visible.has(String(group._id)))) throw AppError.notFound('detachment group');
  res.json(await renderOne(req, group));
});

// POST /detachment-groups
exports.create = catchAsync(async (req, res) => {
  const { name, notes } = req.body;
  await usageService.assertCanConsume(req.tenant, 'detachment_groups');
  await assertNameFree(req.tenantId, name);
  let group;
  try {
    group = await DetachmentGroup.create({ tenantId: req.tenantId, name, notes: notes || undefined });
  } catch (e) {
    if (e && e.code === 11000) throw nameConflict();
    throw e;
  }
  res.status(201).json(await renderOne(req, group));
});

// PUT | PATCH /detachment-groups/:groupId — roll-up fields in the body are ignored
exports.update = catchAsync(async (req, res) => {
  const group = req.docs.group;
  const b = req.body;
  const full = req.method === 'PUT';
  assertBodyId(b.id, group);

  const roll = (await rollups.groupRollups(req.tenantId, [String(group._id)], req.tz)).get(String(group._id));
  const serialize = (g) => ser.detachmentGroup(g, roll);
  assertVersion(group, b.version, serialize);

  if (b.name !== undefined) {
    if (nameKey(b.name) !== group.nameKey) await assertNameFree(req.tenantId, b.name, group._id);
    group.name = b.name;
  }
  if (full || b.notes !== undefined) group.notes = b.notes || undefined;
  if (b.status !== undefined) group.status = b.status;

  await save(group, serialize);
  res.json(await renderOne(req, group));
});

// DELETE /detachment-groups/:groupId — cascades through every detachment inside it
exports.remove = catchAsync(async (req, res) => {
  await cascade.deleteGroup(req.tenantId, String(req.docs.group._id));
  res.status(204).end();
});
