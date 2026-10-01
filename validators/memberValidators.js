/**
 * Joi schemas — team members (volunteer roster records, never accounts).
 *
 * Roles and roster attendance accept the legacy Flutter vocabulary on input
 * (lead/medic/trainee/volunteer, present/late/notInvited) and are converted
 * here, so a controller only ever sees — and stores — the new values.
 */
const Joi = require('joi');
const { TEAM_ROLES, LEGACY_TEAM_ROLE, ATTENDANCE_STATES, LEGACY_ATTENDANCE } = require('../config/constants');
const { collapse, foldDigits } = require('../utils/normalize');

const id = Joi.string().trim().min(1).max(64);
const version = Joi.number().integer().min(1);

const name = Joi.string()
  .trim()
  .min(1)
  .max(80)
  .custom((v) => collapse(v));

const department = Joi.string().trim().allow('').max(80);
const personalNumber = Joi.string()
  .trim()
  .allow('')
  .max(40)
  .custom((v) => foldDigits(v).trim());

/** Stored normalized (ASCII digits, no spaces/dashes/brackets); '' or null clears. */
const phone = Joi.string()
  .trim()
  .allow('', null)
  .max(32)
  .custom((v, helpers) => {
    const cleaned = foldDigits(v).replace(/[\s()-]/g, '');
    if (!/^\+?\d{4,20}$/.test(cleaned)) return helpers.error('any.invalid');
    return cleaned;
  })
  .messages({ 'any.invalid': 'phone must be a phone number (digits, optional leading +)' });

/**
 * A closed vocabulary that also accepts legacy aliases, always converted to the
 * new value. (A custom rule, not `.valid()`: Joi returns allow-listed values
 * without running later rules, so `.valid().custom()` would never map.)
 */
const vocabulary = (values, legacy) =>
  Joi.string()
    .trim()
    .custom((v, helpers) => {
      const out = Object.prototype.hasOwnProperty.call(legacy, v) ? legacy[v] : v;
      return values.includes(out) ? out : helpers.error('any.invalid');
    })
    .messages({ 'any.invalid': `must be one of ${[...values, ...Object.keys(legacy)].join(', ')}` });

const role = vocabulary(TEAM_ROLES, LEGACY_TEAM_ROLE);
const attendance = vocabulary(ATTENDANCE_STATES, LEGACY_ATTENDANCE);

const create = Joi.object({
  detachmentId: id.required(),
  name: name.required(),
  department: department.default(''),
  personalNumber: personalNumber.default(''),
  role: role.default('member'),
  phone,
});

const fromShift = Joi.object({
  detachmentId: id.required(),
  name: name.required(),
});

const matchQuery = Joi.object({
  detachmentId: id.required(),
  name: name.required(),
});

/**
 * PUT = the form's editable fields: name, department and personalNumber are
 * replaced ('' when absent). `phone` and `role` are optional — absent means
 * unchanged, because the roster JSON a client holds carries only
 * `phoneMasked` and must never wipe the stored number.
 */
const put = Joi.object({
  id,
  name: name.required(),
  department: department.default(''),
  personalNumber: personalNumber.default(''),
  phone,
  role,
  version,
});

const patch = Joi.object({
  id,
  name,
  department,
  personalNumber,
  phone,
  role,
  version,
});

const setRole = Joi.object({ role: role.required(), version });
const setAttendance = Joi.object({ attendance: attendance.required(), version });
const lifecycleCommand = Joi.object({ version });

module.exports = { create, fromShift, matchQuery, put, patch, setRole, setAttendance, lifecycleCommand, role, attendance };
