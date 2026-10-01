/**
 * Joi schemas — inventory items and their append-only movement ledger.
 *
 * Quantities are integers. `currentStock` is never accepted from a client:
 * stock only moves through `POST /inventory-items/:id/movements`, so the
 * history always explains the number.
 */
const Joi = require('joi');
const { PACKAGING_UNITS, MOVEMENT_DIRECTIONS } = require('../config/constants');
const { collapse } = require('../utils/normalize');
const { parseDay } = require('../utils/time');

const id = Joi.string().trim().min(1).max(64);
const version = Joi.number().integer().min(1);

const text = (max) =>
  Joi.string()
    .trim()
    .min(1)
    .max(max)
    .custom((v) => collapse(v));

const count = Joi.number().integer().min(0).max(100000000);
const packaging = Joi.number().integer().min(1).max(100000);
const unit = Joi.string().valid(...PACKAGING_UNITS);

/** "YYYY-MM-DD" calendar day in the tenant's calendar (a trailing T00:00 is tolerated). */
const day = Joi.string()
  .custom((v, helpers) => parseDay(v) || helpers.error('any.invalid'))
  .messages({ 'any.invalid': 'must be a calendar day YYYY-MM-DD' });

const create = Joi.object({
  detachmentId: id.required(),
  name: text(80).required(),
  unit: text(40).required(),
  openingStock: count.default(0),
  minimum: count.default(0),
  openingUnit: unit.default('individual'),
  unitsPerStrip: packaging.default(1),
  stripsPerCarton: packaging.default(1),
  preferredUnit: unit,
  expiresOn: day.allow(null),
});

/** PUT: name, unit and minimum are required; packaging/preferredUnit/expiresOn absent = unchanged, `expiresOn: null` clears. */
const put = Joi.object({
  id,
  name: text(80).required(),
  unit: text(40).required(),
  minimum: count.required(),
  unitsPerStrip: packaging,
  stripsPerCarton: packaging,
  preferredUnit: unit,
  expiresOn: day.allow(null),
  version,
});

const patch = Joi.object({
  id,
  name: text(80),
  unit: text(40),
  minimum: count,
  unitsPerStrip: packaging,
  stripsPerCarton: packaging,
  preferredUnit: unit,
  expiresOn: day.allow(null),
  version,
});

/** performedBy / performedByName are NEVER read from the body — they come from the session. */
const movement = Joi.object({
  itemId: id,
  direction: Joi.string()
    .valid(...MOVEMENT_DIRECTIONS)
    .required(),
  quantity: Joi.number().integer().min(1).max(1000000).required(),
  reason: Joi.string().trim().allow('').max(280).default(''),
  packagingUnit: unit.default('individual'),
  source: Joi.string()
    .trim()
    .max(60)
    .pattern(/^[A-Za-z0-9_.:-]+$/),
});

const movementsQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(50),
});

module.exports = { create, put, patch, movement, movementsQuery, day };
