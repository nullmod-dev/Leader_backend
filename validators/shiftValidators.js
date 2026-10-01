/**
 * Joi schemas for shifts, shift templates and attendance.
 *
 * Calendar days accept "YYYY-MM-DD" or the Dart `toIso8601String()` of a
 * local midnight ("2026-09-28T00:00:00.000") and are converted to
 * "YYYY-MM-DD". Instants stay strings here; controllers parse them with
 * `utils/time.parseInstant` in the tenant timezone.
 */
const Joi = require('joi');
const { parseDay } = require('../utils/time');
const { ATTENDANCE_STATES, LEGACY_ATTENDANCE } = require('../config/constants');

const MAX_DAYS = 366;

const day = Joi.string().custom((value, helpers) => parseDay(value) || helpers.message('{{#label}} must be a calendar day (YYYY-MM-DD)'));

/** One of the four attendance states; legacy aliases are accepted and rewritten. */
const attendanceState = Joi.string().custom((value, helpers) => {
  const v = LEGACY_ATTENDANCE[value] || value;
  return ATTENDANCE_STATES.includes(v) ? v : helpers.message(`{{#label}} must be one of ${ATTENDANCE_STATES.join(', ')}`);
});

const instant = Joi.string().trim().max(64);
const version = Joi.number().integer().min(1);

const minutesStart = Joi.number().integer().min(0).max(1439);
const minutesEnd = Joi.number().integer().min(0).max(1440);
const centerName = Joi.string().trim().max(120);
const needed = Joi.number().integer().min(1).max(500);

const createShift = Joi.object({
  date: day.required(),
  centerName: centerName.required(),
  startMinutes: minutesStart.required(),
  endMinutes: minutesEnd.required(),
  needed: needed.required(),
  repeatOn: Joi.array().items(day).max(MAX_DAYS).default([]),
});

const updateShift = Joi.object({
  date: day,
  centerName,
  startMinutes: minutesStart,
  endMinutes: minutesEnd,
  needed,
  version,
});

const range = Joi.object({ from: day.required(), to: day.required() });
const week = Joi.object({ weekStart: day });
const templatesQuery = Joi.object({ active: Joi.boolean() });

const copyDay = Joi.object({ fromDay: day.required(), toDay: day.required() });
const copyWeek = Joi.object({ fromWeekStart: day.required(), toWeekStart: day.required() });

const repeat = Joi.object({ dates: Joi.array().items(day).max(MAX_DAYS).required() });
const templateDates = Joi.object({ dates: Joi.array().items(day).max(MAX_DAYS).required(), version });

const assign = Joi.object({ memberId: Joi.string().trim().max(80).required() });

const at = Joi.object({ at: instant.allow(null, '') });
const markAttendance = Joi.object({ attendance: attendanceState.required() });

const correction = Joi.object({
  status: attendanceState.required(),
  checkInAt: instant.allow(null, ''),
  checkOutAt: instant.allow(null, ''),
  reason: Joi.string().allow('').max(1000).required(),
  correctedAt: instant.allow(null, ''),
});

module.exports = {
  day,
  attendanceState,
  createShift,
  updateShift,
  range,
  week,
  templatesQuery,
  copyDay,
  copyWeek,
  repeat,
  templateDates,
  assign,
  at,
  markAttendance,
  correction,
};
