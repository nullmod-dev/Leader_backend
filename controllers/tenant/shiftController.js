/**
 * Shifts — the detachment schedule tab, the shift manage sheet and the
 * assignment picker (mock_shift_repository.dart).
 *
 * Detachment-scoped handlers read `req.params.detachmentId` (the detachment
 * was loaded in the tenant and the capability checked by the router).
 * Shift-scoped handlers read `req.docs.shift` (loadTenantDoc).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { collapse } = require('../../utils/normalize');
const { todayIn, weekStartOf, addDays, diffDays, eachDay } = require('../../utils/time');
const { assertVersion } = require('../../services/versioning');
const shiftService = require('../../services/shiftService');

const { saveOrStale } = shiftService;
const serializers = require('../../services/serializers');

const MAX_RANGE_DAYS = 62;

const centerOrThrow = (value) => {
  const c = collapse(value);
  if (!c) throw AppError.validation({ centerName: 'The centre name is required.' });
  return c;
};

// ---- detachment-scoped ------------------------------------------------------------

exports.today = catchAsync(async (req, res) => {
  const today = todayIn(req.tz);
  const list = await shiftService.listForDays(req.tenantId, req.params.detachmentId, today, today);
  res.json(await shiftService.toJsonMany(req, list));
});

exports.range = catchAsync(async (req, res) => {
  const { from, to } = req.query;
  if (to < from) throw AppError.validation({ to: '`to` must not be before `from`.' });
  if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) {
    throw AppError.validation({ to: `The range may span at most ${MAX_RANGE_DAYS} days.` });
  }
  const list = await shiftService.listForDays(req.tenantId, req.params.detachmentId, from, to);
  res.json(await shiftService.toJsonMany(req, list));
});

exports.week = catchAsync(async (req, res) => {
  const weekStart = weekStartOf(req.query.weekStart || todayIn(req.tz));
  const days = eachDay(weekStart, addDays(weekStart, 6));
  const list = await shiftService.listForDays(req.tenantId, req.params.detachmentId, weekStart, days[6]);
  res.json({
    weekStart,
    days,
    shifts: await shiftService.toJsonMany(req, list),
    summary: shiftService.weekSummary(list),
  });
});

exports.create = catchAsync(async (req, res) => {
  const b = req.body;
  const spec = {
    centerName: centerOrThrow(b.centerName),
    startMinutes: b.startMinutes,
    endMinutes: b.endMinutes,
    needed: b.needed,
  };
  const { anchor } = await shiftService.createShifts({
    tenantId: req.tenantId,
    tz: req.tz,
    detachmentId: req.params.detachmentId,
    date: b.date,
    spec,
    repeatOn: b.repeatOn || [],
  });
  res.status(201).json(await shiftService.toJson(req, anchor));
});

exports.copyDay = catchAsync(async (req, res) => {
  const created = await shiftService.copyDay({
    tenantId: req.tenantId,
    tz: req.tz,
    detachmentId: req.params.detachmentId,
    fromDay: req.body.fromDay,
    toDay: req.body.toDay,
  });
  res.json({ created });
});

exports.copyWeek = catchAsync(async (req, res) => {
  const created = await shiftService.copyWeek({
    tenantId: req.tenantId,
    tz: req.tz,
    detachmentId: req.params.detachmentId,
    fromWeekStart: weekStartOf(req.body.fromWeekStart),
    toWeekStart: weekStartOf(req.body.toWeekStart),
  });
  res.json({ created });
});

// ---- one shift ------------------------------------------------------------------------

exports.get = catchAsync(async (req, res) => {
  res.json(await shiftService.toJson(req, req.docs.shift));
});

/** PUT and PATCH: partial edit of the spec; the absolute window is recomputed. */
exports.update = catchAsync(async (req, res) => {
  const shift = req.docs.shift;
  const b = req.body;
  const serialize = await shiftService.serializerFor(req, [shift]);
  assertVersion(shift, b.version, serialize);

  const next = {
    date: b.date ?? shift.date,
    centerName: b.centerName !== undefined ? centerOrThrow(b.centerName) : shift.centerName,
    startMinutes: b.startMinutes ?? shift.startMinutes,
    endMinutes: b.endMinutes ?? shift.endMinutes,
    needed: b.needed ?? shift.needed,
  };
  shiftService.assertTimes(next.startMinutes, next.endMinutes);
  Object.assign(shift, next);
  shiftService.applyWindow(shift, req.tz);
  await saveOrStale(shift, serialize);
  res.json(await shiftService.toJson(req, shift));
});

exports.remove = catchAsync(async (req, res) => {
  await req.docs.shift.deleteOne();
  res.status(204).end();
});

exports.updateRepeat = catchAsync(async (req, res) => {
  const { template, shifts } = await shiftService.updateRepeat({
    tenantId: req.tenantId,
    tz: req.tz,
    shiftId: req.docs.shift._id,
    dates: req.body.dates,
  });
  res.json({ template: serializers.template(template), shifts: await shiftService.toJsonMany(req, shifts) });
});

// ---- assignment ----------------------------------------------------------------------------

exports.assign = catchAsync(async (req, res) => {
  const { memberId } = req.body;
  const { shift } = await shiftService.mutate(req, async (doc) => {
    await shiftService.assertAssignable(req.tenantId, doc, memberId);
    doc.attendees.push({ memberId, attendance: 'notCheckedIn' });
  });
  res.json(await shiftService.toJson(req, shift));
});

exports.unassign = catchAsync(async (req, res) => {
  const { memberId } = req.params;
  const { shift } = await shiftService.mutate(req, async (doc) => {
    const i = doc.attendees.findIndex((a) => a.memberId === memberId);
    if (i < 0) throw AppError.notFound('assignment');
    doc.attendees.splice(i, 1);
  });
  res.json(await shiftService.toJson(req, shift));
});

exports.candidates = catchAsync(async (req, res) => {
  const rows = await shiftService.candidates(req.tenantId, req.docs.shift);
  res.json(shiftService.candidatesJson(rows, req.grant));
});

/** Add free candidates (candidate order) until the shift has no gap. */
exports.quickFill = catchAsync(async (req, res) => {
  const { shift, result } = await shiftService.mutate(req, async (doc) => {
    const rows = await shiftService.candidates(req.tenantId, doc);
    let added = 0;
    for (const r of rows) {
      if (doc.attendees.length >= doc.needed) break;
      if (r.busyWith) continue;
      doc.attendees.push({ memberId: String(r.member._id), attendance: 'notCheckedIn' });
      added += 1;
    }
    return added;
  });
  res.json({ added: result, shift: await shiftService.toJson(req, shift) });
});
