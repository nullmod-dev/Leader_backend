/**
 * The workshop register — team members typed by name, guests
 * (volunteers/visitors), the legacy roster registration, and per-line
 * attendance/payment. Every write refuses an archived workshop (409 archived).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { assertVersion, saveVersioned } = require('../../services/versioning');
const serializers = require('../../services/serializers');
const workshopService = require('../../services/workshopService');

// ---- under /workshops/:workshopId -------------------------------------------------------

exports.addTeamMember = catchAsync(async (req, res) => {
  const name = workshopService.normalizedNameOrThrow(req.body.name);
  const p = await workshopService.addLine({
    tenantId: req.tenantId,
    workshopId: String(req.docs.workshop._id),
    kind: 'member',
    name,
    role: req.body.role,
    paid: req.body.paid,
  });
  res.status(201).json(serializers.participant(p));
});

exports.addGuest = catchAsync(async (req, res) => {
  const name = workshopService.normalizedNameOrThrow(req.body.name);
  const p = await workshopService.addLine({
    tenantId: req.tenantId,
    workshopId: String(req.docs.workshop._id),
    kind: 'guest',
    name,
    paid: req.body.paid,
  });
  res.status(201).json(serializers.participant(p));
});

/** LEGACY roster registration — all or nothing. */
exports.addRosterMembers = catchAsync(async (req, res) => {
  const lines = await workshopService.addRosterLines({
    tenantId: req.tenantId,
    workshopId: String(req.docs.workshop._id),
    memberIds: req.body.memberIds,
  });
  res.status(201).json(lines.map(serializers.participant));
});

// ---- under /workshop-participants/:participantId ------------------------------------------

/** Rename / re-role / re-price a TEAM MEMBER line (guest lines are not editable → 404). */
exports.update = catchAsync(async (req, res) => {
  const p = req.docs.participant;
  if (p.kind !== 'member') throw AppError.notFound('participant');
  assertVersion(p, req.body.version, serializers.participant);
  const name = workshopService.normalizedNameOrThrow(req.body.name);
  if (await workshopService.nameTaken(req.tenantId, p.workshopId, 'member', name, { except: p._id })) {
    throw workshopService.duplicateError();
  }
  p.name = name;
  p.role = req.body.role;
  p.paymentStatus = req.body.paid ? 'paid' : 'unpaid';
  await saveVersioned(p, serializers.participant);
  res.json(serializers.participant(p));
});

/** Removes the register line only — a TeamMember behind a legacy line is untouched. */
exports.remove = catchAsync(async (req, res) => {
  await req.docs.participant.deleteOne();
  res.status(204).end();
});

exports.setAttendance = catchAsync(async (req, res) => {
  const p = req.docs.participant;
  assertVersion(p, req.body.version, serializers.participant);
  p.attendance = req.body.attendance;
  await saveVersioned(p, serializers.participant);
  res.json(serializers.participant(p));
});

exports.setPayment = catchAsync(async (req, res) => {
  const p = req.docs.participant;
  assertVersion(p, req.body.version, serializers.participant);
  p.paymentStatus = req.body.paymentStatus;
  await saveVersioned(p, serializers.participant);
  res.json(serializers.participant(p));
});
