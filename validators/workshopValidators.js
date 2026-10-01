/**
 * Joi schemas for workshops, their register and their organising team.
 *
 * Unknown keys are stripped by `middlewares/validate` — which is exactly how a
 * full `Workshop` JSON sent to PUT loses `registered`, `guests`,
 * `organizingTeam` and `archived` (server-owned, never client-editable).
 */
const Joi = require('joi');
const { WORKSHOP_STATUS, WORKSHOP_ROLES } = require('../config/constants');
const { attendanceState } = require('./shiftValidators');

const name = Joi.string().trim().max(160);
const location = Joi.string().trim().max(200);
const instant = Joi.string().trim().max(64);
const capacity = Joi.number().integer().min(1).max(100000);
const fee = Joi.number().min(0).max(1e12);
const version = Joi.number().integer().min(1);
const memberIds = Joi.array().items(Joi.string().trim().min(1).max(80)).min(1).max(500);

const listQuery = Joi.object({
  bucket: Joi.string().valid('upcoming', 'past', 'archived', 'all'),
  query: Joi.string().allow('').max(200),
});

const create = Joi.object({
  name: name.required(),
  at: instant.required(),
  location: location.required(),
  capacity: capacity.required(),
  registrationFee: fee.default(0),
});

const update = Joi.object({
  id: Joi.string(),
  name,
  at: instant,
  location,
  capacity,
  status: Joi.string().valid(...WORKSHOP_STATUS),
  registrationFee: fee,
  version,
});

const archive = Joi.object({ archived: Joi.boolean().required() });

/** Names are normalized (collapse) in the controller; blank → 422 there. */
const teamMember = Joi.object({
  name: Joi.string().allow('').max(160).required(),
  role: Joi.string().valid(...WORKSHOP_ROLES).required(),
  paid: Joi.boolean().default(false),
  version,
});

const guest = Joi.object({
  name: Joi.string().allow('').max(160).required(),
  paid: Joi.boolean().default(false),
});

const legacyParticipants = Joi.object({ memberIds: memberIds.required() });
const organizers = Joi.object({ memberIds: memberIds.required(), version });

const attendance = Joi.object({ attendance: attendanceState.required(), version });
const payment = Joi.object({ paymentStatus: Joi.valid('paid', 'unpaid', null).required(), version });

module.exports = {
  listQuery,
  create,
  update,
  archive,
  teamMember,
  guest,
  legacyParticipants,
  organizers,
  attendance,
  payment,
};
