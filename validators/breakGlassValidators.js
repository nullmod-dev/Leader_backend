/**
 * Break-glass (Point 12). `reason` and `scopes` are accepted as-is here and
 * judged by the service, because each has its own feature-owned code
 * (`invalid_break_glass_reason`, `invalid_break_glass_scope`) rather than the
 * generic `validation`.
 */
const Joi = require('joi');
const { BREAK_GLASS_STATUS } = require('../config/constants');

const activate = Joi.object({
  tenantId: Joi.string().trim().max(64).required(),
  expectedTenantVersion: Joi.number().integer().min(1).required(),
  scopes: Joi.any(),
  reason: Joi.any(),
});

const revisionCommand = Joi.object({
  expectedRevision: Joi.number().integer().min(1).required(),
});

const listQuery = Joi.object({
  status: Joi.string().valid(...BREAK_GLASS_STATUS),
  cursor: Joi.string().max(1024),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

const viewQuery = Joi.object({
  detachmentId: Joi.string().trim().max(64),
  from: Joi.string().trim().max(40),
  to: Joi.string().trim().max(40),
});

module.exports = { activate, revisionCommand, listQuery, viewQuery };
