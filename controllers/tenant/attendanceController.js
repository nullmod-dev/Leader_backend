/**
 * Shift attendance — the attendance sheet (ordinary path) and the correction
 * form (override path). See services/attendanceService.js for the rules.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { collapse } = require('../../utils/normalize');
const { parseInstant } = require('../../utils/time');
const shiftService = require('../../services/shiftService');
const attendance = require('../../services/attendanceService');

/** Parse an optional client instant; garbage → 422 on that field. */
const instantOrNull = (value, field, tz) => {
  if (value === undefined || value === null || value === '') return null;
  const d = parseInstant(value, tz);
  if (!d) throw AppError.validation({ [field]: `${field} must be an ISO 8601 instant.` });
  return d;
};

/**
 * Ordinary edit: window check (server time, current grace) on the freshest
 * shift, then `apply(shift)`, then save (with lost-race retry).
 */
const ordinary = (apply) =>
  catchAsync(async (req, res) => {
    const grace = await shiftService.graceMinutes();
    const { shift } = await shiftService.mutate(req, (doc) => {
      attendance.assertWindowOpen(doc, grace, new Date());
      return apply(req, doc);
    });
    res.json(await shiftService.toJson(req, shift));
  });

exports.checkIn = ordinary((req, shift) => {
  const at = instantOrNull(req.body.at, 'at', req.tz) || new Date();
  attendance.checkIn(shift, req.params.memberId, at);
});

exports.checkOut = ordinary((req, shift) => {
  const at = instantOrNull(req.body.at, 'at', req.tz) || new Date();
  attendance.checkOut(shift, req.params.memberId, at, req.tz);
});

exports.absent = ordinary((req, shift) => attendance.markAbsent(shift, req.params.memberId));

exports.reset = ordinary((req, shift) => attendance.reset(shift, req.params.memberId));

/** Legacy markAttendance: dispatches to the four edits using SERVER now. */
exports.mark = ordinary((req, shift) => attendance.applyState(shift, req.params.memberId, req.body.attendance, new Date(), req.tz));

/** Append-only correction; override only; valid after the window. */
exports.correct = catchAsync(async (req, res) => {
  const b = req.body;
  const reason = collapse(b.reason);
  if (!reason) throw AppError.validation({ reason: 'A correction needs a reason.' });
  const input = {
    status: b.status,
    checkInAt: instantOrNull(b.checkInAt, 'checkInAt', req.tz),
    checkOutAt: instantOrNull(b.checkOutAt, 'checkOutAt', req.tz),
    reason,
    clientCorrectedAt: instantOrNull(b.correctedAt, 'correctedAt', req.tz),
  };
  const account = req.auth.account;
  const author = { id: String(account._id), displayName: account.name || '' };
  const { shift } = await shiftService.mutate(req, (doc) =>
    attendance.correct(doc, req.params.memberId, input, author, new Date(), req.tz),
  );
  res.json(await shiftService.toJson(req, shift));
});

exports.listCorrections = catchAsync(async (req, res) => {
  res.json(shiftService.correctionsJson(req.docs.shift));
});
