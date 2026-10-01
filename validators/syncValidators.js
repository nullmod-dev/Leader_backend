/**
 * Joi schemas — offline sync (/sync). See docs/api/sync.md.
 */
const Joi = require('joi');

const MAX_OPERATIONS = 50;

/** Same alphabet as the Idempotency-Key header (the operationId IS the key). */
const OPERATION_ID = /^[A-Za-z0-9:_\-.]{8,64}$/;

const operation = Joi.object({
  operationId: Joi.string().pattern(OPERATION_ID).required().messages({
    'string.pattern.base': 'operationId must be 8–64 characters of [A-Za-z0-9:_-.] (a UUIDv7).',
  }),
  kind: Joi.string().trim().min(1).max(80).required(),
  payload: Joi.object().unknown(true).default({}),
  version: Joi.number().integer().min(1),
});

/** POST /sync/push */
const push = Joi.object({
  operations: Joi.array().items(operation).min(1).max(MAX_OPERATIONS).required(),
});

module.exports = { push, MAX_OPERATIONS, OPERATION_ID };
