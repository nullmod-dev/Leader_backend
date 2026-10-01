/**
 * Detachments — /api/v1/detachments (Flutter /detachment-groups/:groupId,
 * /detachment/:id and its tabs team / shifts / storage / stats).
 *
 * Shift routes under /detachments/:detachmentId/shifts* belong to
 * routes/detachmentShiftRoutes.js, not here.
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { TEAM_ROLES } = require('../../config/constants');
const { Detachment, DetachmentGroup, TeamMember, InventoryItem, InventoryMovement } = require('../../models');
const ser = require('../../services/serializers');
const rollups = require('../../services/rollups');
const usageService = require('../../services/usageService');
const storageService = require('../../services/storageService');
const cascade = require('../../services/detachmentCascade');
const statsService = require('../../services/detachmentStatsService');
const { assertVersion, saveVersioned } = require('../../services/versioning');
const { searchFold } = require('../../utils/normalize');

const render = async (req, dets) => {
  const roll = await rollups.detachmentRollups(
    req.tenantId,
    dets.map((d) => String(d._id)),
    req.tz,
  );
  return dets.map((d) => ser.detachment(d, roll.get(String(d._id))));
};

const renderOne = async (req, det) => (await render(req, [det]))[0];

/** Serializer carrying the CURRENT roll-ups, for stale_write.currentRecord. */
const serializerFor = async (req, det) => {
  const roll = (await rollups.detachmentRollups(req.tenantId, [String(det._id)], req.tz)).get(String(det._id));
  return (d) => ser.detachment(d, roll);
};

const assertBodyId = (bodyId, doc) => {
  if (bodyId !== undefined && bodyId !== String(doc._id)) {
    throw AppError.validation({ id: 'The body id must equal the id in the path.' });
  }
};

const assertGroupExists = async (tenantId, groupId) => {
  if (!(await DetachmentGroup.exists({ tenantId, _id: groupId }))) {
    throw AppError.validation({ detachmentGroupId: 'No detachment group with this id exists in your team.' });
  }
};

/** Re-encode an upload; an undecodable file is a validation failure, not a 500. */
const saveUpload = async (req, preset, ownerType, ownerId) => {
  try {
    return await storageService.saveImage(req.file.buffer, preset, { ownerType, ownerId: String(ownerId), tenantId: req.tenantId });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.validation({ image: 'The file is not a readable image.' });
  }
};

// GET /detachments?detachmentGroupId&filter=active|archived&query
exports.list = catchAsync(async (req, res) => {
  const q = req.query;
  const filter = { tenantId: req.tenantId };
  const visible = caps.visibleDetachmentIds(req.grant);
  if (visible !== null) filter._id = { $in: visible };
  if (q.detachmentGroupId) filter.detachmentGroupId = q.detachmentGroupId;
  if (q.filter === 'active' || q.filter === 'archived') filter.status = q.filter;
  let dets = await Detachment.find(filter).sort({ createdAt: 1, _id: 1 });
  const needle = searchFold(q.query || '');
  if (needle) {
    dets = dets.filter((d) => [d.name, d.region, d.mainCenter, d.notes].some((v) => v && searchFold(v).includes(needle)));
  }
  res.json(await render(req, dets));
});

// GET /detachments/:detachmentId
exports.get = catchAsync(async (req, res) => {
  res.json(await renderOne(req, req.docs.detachment));
});

// POST /detachments
exports.create = catchAsync(async (req, res) => {
  const b = req.body;
  await assertGroupExists(req.tenantId, b.detachmentGroupId);
  await usageService.assertCanConsume(req.tenant, 'detachments');
  const det = await Detachment.create({
    tenantId: req.tenantId,
    detachmentGroupId: b.detachmentGroupId,
    name: b.name,
    region: b.region,
    mainCenter: b.mainCenter,
    notes: b.notes || undefined,
  });
  res.status(201).json(await renderOne(req, det));
});

// PUT | PATCH /detachments/:detachmentId
exports.update = catchAsync(async (req, res) => {
  const det = req.docs.detachment;
  const b = req.body;
  const full = req.method === 'PUT';
  assertBodyId(b.id, det);

  const statusChange = b.status !== undefined && b.status !== det.status;
  if (statusChange && !caps.canIn(req.grant, String(det._id), 'detachment.archive')) {
    throw AppError.notPermitted('Changing the status requires detachment.archive in this detachment.');
  }

  const serialize = await serializerFor(req, det);
  assertVersion(det, b.version, serialize);

  if (b.detachmentGroupId !== undefined && b.detachmentGroupId !== det.detachmentGroupId) {
    await assertGroupExists(req.tenantId, b.detachmentGroupId);
    det.detachmentGroupId = b.detachmentGroupId;
  }
  if (statusChange && b.status === 'active') await usageService.assertCanConsume(req.tenant, 'detachments');

  if (b.name !== undefined) det.name = b.name;
  if (b.region !== undefined) det.region = b.region;
  if (b.mainCenter !== undefined) det.mainCenter = b.mainCenter;
  if (full || b.notes !== undefined) det.notes = b.notes || undefined;
  if (statusChange) det.status = b.status;

  await saveVersioned(det, serialize);
  res.json(await renderOne(req, det));
});

// POST /detachments/:detachmentId/archive | /restore
const setStatus = (target) =>
  catchAsync(async (req, res) => {
    const det = req.docs.detachment;
    const serialize = await serializerFor(req, det);
    assertVersion(det, req.body && req.body.version, serialize);
    if (det.status !== target) {
      if (target === 'active') await usageService.assertCanConsume(req.tenant, 'detachments');
      det.status = target;
      await saveVersioned(det, serialize);
    }
    res.json(await renderOne(req, det));
  });

exports.archive = setStatus('archived');
exports.restore = setStatus('active');

// DELETE /detachments/:detachmentId — cascade
exports.remove = catchAsync(async (req, res) => {
  await cascade.deleteDetachment(req.tenantId, String(req.docs.detachment._id));
  res.status(204).end();
});

// GET /detachments/:detachmentId/stats?days=7
exports.stats = catchAsync(async (req, res) => {
  res.json(
    await statsService.forDetachment({
      tenantId: req.tenantId,
      detachmentId: String(req.docs.detachment._id),
      tz: req.tz,
      days: req.query.days,
      inventoryEnabled: req.tenant.featureEnabled('inventory'),
    }),
  );
});

// POST /detachments/:detachmentId/image (multipart "image")
exports.setImage = catchAsync(async (req, res) => {
  const det = req.docs.detachment;
  const saved = await saveUpload(req, 'detachment', 'detachment', det._id);
  const previous = det.imagePath;
  det.imagePath = saved.path;
  try {
    await saveVersioned(det, await serializerFor(req, det));
  } catch (e) {
    await storageService.removeFile(saved.path);
    throw e;
  }
  if (previous) await storageService.removeFile(previous);
  res.json(await renderOne(req, det));
});

// DELETE /detachments/:detachmentId/image
exports.removeImage = catchAsync(async (req, res) => {
  const det = req.docs.detachment;
  const previous = det.imagePath;
  if (previous) {
    det.imagePath = undefined;
    await saveVersioned(det, await serializerFor(req, det));
    await storageService.removeFile(previous);
  }
  res.json(await renderOne(req, det));
});

// GET /detachments/:detachmentId/members?includeInactive=true
const ROLE_ORDER = new Map(TEAM_ROLES.map((r, i) => [r, i]));
exports.members = catchAsync(async (req, res) => {
  const filter = { tenantId: req.tenantId, detachmentId: String(req.docs.detachment._id) };
  if (!req.query.includeInactive) filter.active = true;
  const members = await TeamMember.find(filter);
  members.sort(
    (a, b) =>
      (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) || a.name.localeCompare(b.name, 'ar') || String(a._id).localeCompare(String(b._id)),
  );
  res.json(members.map((m) => ser.member(m, { grant: req.grant })));
});

// GET /detachments/:detachmentId/inventory-items
exports.inventoryItems = catchAsync(async (req, res) => {
  const items = await InventoryItem.find({ tenantId: req.tenantId, detachmentId: String(req.docs.detachment._id) });
  items.sort((a, b) => a.name.localeCompare(b.name, 'ar') || String(a._id).localeCompare(String(b._id)));
  res.json(items.map(ser.inventoryItem));
});

// GET /detachments/:detachmentId/inventory-movements?limit=50
exports.inventoryMovements = catchAsync(async (req, res) => {
  const movements = await InventoryMovement.find({ tenantId: req.tenantId, detachmentId: String(req.docs.detachment._id) })
    .sort({ at: -1, _id: -1 })
    .limit(req.query.limit || 50);
  res.json(movements.map(ser.movement));
});
