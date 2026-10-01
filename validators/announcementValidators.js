/**
 * Joi schemas for announcements. Shape only — the business rules (text
 * bounds after trimming, ACTIVE detachments, per-detachment authority,
 * finite expiry, advisory publishedAt) live in the controller so each one
 * answers with its own field.
 */
const Joi = require('joi');
const { ANNOUNCEMENT_STATUS } = require('../config/constants');

const listQuery = Joi.object({
  status: Joi.string().valid(...ANNOUNCEMENT_STATUS),
  detachmentId: Joi.string().trim().max(80),
});

const publish = Joi.object({
  text: Joi.string().allow('').max(5000).required(),
  detachmentIds: Joi.array().items(Joi.string().trim().min(1).max(80)).min(1).max(200).required(),
  // Unknown placement names are dropped by the controller, never refused.
  placements: Joi.array().items(Joi.string().allow('').max(40)).max(20).default([]),
  expiresAt: Joi.string().trim().max(64).required(),
  publishedAt: Joi.string().trim().max(64).allow(null, ''),
});

module.exports = { listQuery, publish };
