/** Customer Demo (BACKEND-HANDOFF.md §12). Durations are integer MINUTES. */
const Joi = require('joi');
const { DEMO_SESSION_STATUS } = require('../config/constants');

/** Optional client install id: only its hash is stored (resume key). */
const start = Joi.object({
  installId: Joi.string().trim().min(8).max(128),
});

const policyPatch = Joi.object({
  enabled: Joi.boolean().strict(),
  defaultDurationMinutes: Joi.number().integer().min(60).messages({
    'number.base': 'defaultDurationMinutes must be an integer number of minutes.',
    'number.integer': 'defaultDurationMinutes must be an integer number of minutes.',
    'number.min': 'defaultDurationMinutes must be at least 60 minutes.',
  }),
  expectedRevision: Joi.number().integer().min(1).required(),
});

const sessionsQuery = Joi.object({
  status: Joi.string().valid(...DEMO_SESSION_STATUS),
  cursor: Joi.string().max(1024),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

module.exports = { start, policyPatch, sessionsQuery };
