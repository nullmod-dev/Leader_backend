/**
 * Workshops — the /workshop list, the workshop detail header, its tabs
 * (register, organising team, statistics) and the cover image.
 * Organisation-level: no detachment id anywhere.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { collapse, searchFold } = require('../../utils/normalize');
const { parseInstant } = require('../../utils/time');
const { assertVersion } = require('../../services/versioning');
const { saveOrStale } = require('../../services/shiftService');
const usageService = require('../../services/usageService');
const storageService = require('../../services/storageService');
const serializers = require('../../services/serializers');
const workshopService = require('../../services/workshopService');
const stats = require('../../services/workshopStatsService');
const { Workshop } = require('../../models');

const instantOrThrow = (value, tz, field = 'at') => {
  const d = parseInstant(value, tz);
  if (!d) throw AppError.validation({ [field]: `${field} must be an ISO 8601 instant.` });
  return d;
};

const requiredText = (value, field) => {
  const s = collapse(value);
  if (!s) throw AppError.validation({ [field]: `${field} is required.` });
  return s;
};

// ---- reads ------------------------------------------------------------------------------

exports.list = catchAsync(async (req, res) => {
  const { bucket, query } = req.query;
  let list = await Workshop.find({ tenantId: req.tenantId }).sort({ at: 1, _id: 1 });
  const now = Date.now();
  if (bucket === 'upcoming') list = list.filter((w) => !w.archived && w.at.getTime() > now);
  else if (bucket === 'past') list = list.filter((w) => !w.archived && w.at.getTime() <= now);
  else if (bucket === 'archived') list = list.filter((w) => w.archived);
  const q = searchFold(query || '');
  if (q) list = list.filter((w) => searchFold(`${w.name} ${w.location}`).includes(q));
  res.json(await serializers.workshops(req.tenantId, list, { grant: req.grant }));
});

exports.get = catchAsync(async (req, res) => {
  res.json(await workshopService.toJson(req, req.docs.workshop));
});

exports.participants = catchAsync(async (req, res) => {
  const register = await workshopService.registerOf(req.tenantId, String(req.docs.workshop._id));
  res.json(register.map(serializers.participant));
});

exports.stats = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const register = await workshopService.registerOf(req.tenantId, String(w._id));
  const members = await serializers.memberMap(req.tenantId, (w.organizingTeam || []).map((o) => o.memberId));
  res.json(stats.compute(w, register, members));
});

exports.exportCsv = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const register = await workshopService.registerOf(req.tenantId, String(w._id));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="workshop-${String(w._id)}.csv"`);
  res.status(200).send(stats.registerCsv(register));
});

// ---- writes -----------------------------------------------------------------------------

exports.create = catchAsync(async (req, res) => {
  const b = req.body;
  const doc = {
    tenantId: req.tenantId,
    name: requiredText(b.name, 'name'),
    at: instantOrThrow(b.at, req.tz),
    location: requiredText(b.location, 'location'),
    capacity: b.capacity,
    registrationFee: b.registrationFee ?? 0,
    status: 'scheduled',
    organizingTeam: [],
  };
  await usageService.assertCanConsume(req.tenant, 'workshops');
  const w = await Workshop.create(doc);
  res.status(201).json(await workshopService.toJson(req, w));
});

/** PUT and PATCH — only name, at, location, capacity, status, registrationFee. */
exports.update = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const b = req.body;
  if (b.id !== undefined && b.id !== String(w._id)) {
    throw AppError.validation({ id: 'The body id must equal the workshop id in the path.' });
  }
  const serialize = await workshopService.serializerFor(req, w);
  assertVersion(w, b.version, serialize);

  if (b.name !== undefined) w.name = requiredText(b.name, 'name');
  if (b.location !== undefined) w.location = requiredText(b.location, 'location');
  if (b.at !== undefined) w.at = instantOrThrow(b.at, req.tz);
  if (b.status !== undefined) w.status = b.status;
  if (b.registrationFee !== undefined) w.registrationFee = b.registrationFee;
  if (b.capacity !== undefined) {
    const { registered } = await workshopService.registerCounts(req.tenantId, String(w._id));
    if (b.capacity < registered) {
      throw new AppError('capacity_below_registered', 409, 'The capacity cannot be below the number already registered.', { registered });
    }
    w.capacity = b.capacity;
  }
  await saveOrStale(w, serialize);
  res.json(await workshopService.toJson(req, w));
});

/** Archive / restore. Same state again is a 200 no-op; restoring counts against the plan. */
exports.archive = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const { archived } = req.body;
  if (!!w.archived !== archived) {
    const serialize = await workshopService.serializerFor(req, w);
    if (!archived) await usageService.assertCanConsume(req.tenant, 'workshops');
    w.archived = archived;
    w.archivedAt = archived ? new Date() : undefined;
    await saveOrStale(w, serialize);
  }
  res.json(await workshopService.toJson(req, w));
});

exports.setCover = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const saved = await storageService.saveImage(req.file.buffer, 'workshop', {
    ownerType: 'workshop',
    ownerId: String(w._id),
    tenantId: req.tenantId,
  });
  const previous = w.coverImagePath;
  w.coverImagePath = saved.path;
  try {
    await saveOrStale(w, await workshopService.serializerFor(req, w));
  } catch (err) {
    await storageService.removeFile(saved.path);
    throw err;
  }
  if (previous) await storageService.removeFile(previous);
  res.json(await workshopService.toJson(req, w));
});

exports.removeCover = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const previous = w.coverImagePath;
  if (previous) {
    w.coverImagePath = undefined;
    await saveOrStale(w, await workshopService.serializerFor(req, w));
    await storageService.removeFile(previous);
  }
  res.json(await workshopService.toJson(req, w));
});

// ---- organising team ---------------------------------------------------------------------

exports.addOrganizers = catchAsync(async (req, res) => {
  const w = await workshopService.addOrganizers({
    tenantId: req.tenantId,
    workshopId: String(req.docs.workshop._id),
    memberIds: req.body.memberIds,
    version: req.body.version,
    serialize: await workshopService.serializerFor(req, req.docs.workshop),
  });
  res.json(await workshopService.toJson(req, w));
});

const organizerIndex = (w, memberId) => {
  const i = (w.organizingTeam || []).findIndex((o) => o.memberId === memberId);
  if (i < 0) throw AppError.notFound('organizer');
  return i;
};

exports.removeOrganizer = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const i = organizerIndex(w, req.params.memberId);
  w.organizingTeam.splice(i, 1);
  await saveOrStale(w, await workshopService.serializerFor(req, w));
  res.json(await workshopService.toJson(req, w));
});

exports.setOrganizerAttendance = catchAsync(async (req, res) => {
  const w = req.docs.workshop;
  const serialize = await workshopService.serializerFor(req, w);
  assertVersion(w, req.body.version, serialize);
  const i = organizerIndex(w, req.params.memberId);
  w.organizingTeam[i].attendance = req.body.attendance;
  await saveOrStale(w, serialize);
  res.json(await workshopService.toJson(req, w));
});
