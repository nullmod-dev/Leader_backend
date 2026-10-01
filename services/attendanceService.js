/**
 * Shift attendance (attendance_policy.dart + mock_shift_repository.dart).
 *
 * Two DISJOINT mutation paths:
 *
 *  1. Ordinary — check-in / check-out / absent / reset (and the legacy
 *     markAttendance that dispatches to them). Needs
 *     shift.attendance.record OR shift.attendance.override AND the window
 *     open: SERVER now < endsAt + settings.attendanceGraceMinutes
 *     (`now == lock` is closed) → else 409 attendance_window_expired.
 *  2. Correction — shift.attendance.override only, valid forever. Appends an
 *     immutable correction {before, after, reason, author, correctedAt} and
 *     applies `after` to the attendee. There is no update/delete path.
 *
 * Physical consistency (both paths): a check-out before the check-in is
 * refused — except an overnight shift, where a check-out that falls on the
 * shift's own start day is read as the next morning (+1 calendar day).
 */
const { DateTime } = require('luxon');
const AppError = require('../utils/appError');
const { ulid } = require('../utils/ids');
const { iso, dayOf, addMinutes } = require('../utils/time');

const crossesMidnight = (shift) => shift.endMinutes <= shift.startMinutes;

const lockTime = (shift, grace) => addMinutes(shift.endsAt, grace);

/** 409 attendance_window_expired once `now` reaches endsAt + grace. */
const assertWindowOpen = (shift, grace, now = new Date()) => {
  const lock = lockTime(shift, grace);
  if (!(now.getTime() < lock.getTime())) {
    throw new AppError('attendance_window_expired', 409, 'The ordinary attendance window for this shift has closed.', {
      closesAt: iso(lock),
    });
  }
};

const attendeeOf = (shift, memberId) => {
  const a = (shift.attendees || []).find((x) => x.memberId === memberId);
  if (!a) throw AppError.notFound('attendee');
  return a;
};

const plusOneDay = (date, tz) => DateTime.fromJSDate(date).setZone(tz).plus({ days: 1 }).toJSDate();

/** Overnight normalization shared by check-out and corrections. */
const normalizeCheckOut = (shift, checkIn, checkOut, tz) => {
  let out = checkOut;
  if (out.getTime() < checkIn.getTime() && crossesMidnight(shift) && dayOf(out, tz) === shift.date) {
    out = plusOneDay(out, tz);
  }
  if (out.getTime() < checkIn.getTime()) {
    throw new AppError('checkout_before_checkin', 422, 'The check-out is before the check-in.');
  }
  return out;
};

// ---- the four ordinary edits (mutate the attendee in place) ---------------------------

const checkIn = (shift, memberId, at) => {
  const a = attendeeOf(shift, memberId);
  if (a.checkOutAt && at.getTime() > new Date(a.checkOutAt).getTime()) {
    throw new AppError('checkin_after_checkout', 422, 'The check-in is after the recorded check-out.');
  }
  a.checkInAt = at;
  a.attendance = a.checkOutAt ? 'checkedOut' : 'checkedIn';
};

const checkOut = (shift, memberId, at, tz) => {
  const a = attendeeOf(shift, memberId);
  if (!a.checkInAt) throw new AppError('check_in_required', 422, 'Record a check-in before the check-out.');
  a.checkOutAt = normalizeCheckOut(shift, new Date(a.checkInAt), at, tz);
  a.attendance = 'checkedOut';
};

const markAbsent = (shift, memberId) => {
  const a = attendeeOf(shift, memberId);
  a.attendance = 'absent';
  a.checkInAt = null;
  a.checkOutAt = null;
};

const reset = (shift, memberId) => {
  const a = attendeeOf(shift, memberId);
  a.attendance = 'notCheckedIn';
  a.checkInAt = null;
  a.checkOutAt = null;
};

/** Legacy markAttendance: one state → one of the four edits, at SERVER now. */
const applyState = (shift, memberId, state, now, tz) => {
  switch (state) {
    case 'checkedIn':
      return checkIn(shift, memberId, now);
    case 'checkedOut':
      return checkOut(shift, memberId, now, tz);
    case 'absent':
      return markAbsent(shift, memberId);
    default:
      return reset(shift, memberId);
  }
};

// ---- corrections -------------------------------------------------------------------------

/**
 * Append one correction and apply it. `input` = { status, checkInAt, checkOutAt,
 * reason (normalized), clientCorrectedAt } with instants already parsed.
 */
const correct = (shift, memberId, input, author, now, tz) => {
  const a = attendeeOf(shift, memberId);
  let checkOutAt = input.checkOutAt || null;
  const checkInAt = input.checkInAt || null;
  if (checkInAt && checkOutAt) checkOutAt = normalizeCheckOut(shift, checkInAt, checkOutAt, tz);

  const correction = {
    _id: `corr_${ulid()}`,
    memberId,
    before: { status: a.attendance, checkInAt: a.checkInAt || null, checkOutAt: a.checkOutAt || null },
    after: { status: input.status, checkInAt, checkOutAt },
    reason: input.reason,
    author,
    correctedAt: now,
    clientCorrectedAt: input.clientCorrectedAt || null,
  };
  shift.corrections.push(correction);
  a.attendance = input.status;
  a.checkInAt = checkInAt;
  a.checkOutAt = checkOutAt;
  return correction;
};

module.exports = {
  crossesMidnight,
  lockTime,
  assertWindowOpen,
  attendeeOf,
  normalizeCheckOut,
  checkIn,
  checkOut,
  markAbsent,
  reset,
  applyState,
  correct,
};
