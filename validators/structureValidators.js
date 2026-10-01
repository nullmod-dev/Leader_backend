/**
 * Joi schemas — detachment groups, detachments, and the read-only
 * home / notifications / search query strings.
 *
 * `validate()` strips unknown keys, so the roll-up fields a client echoes back
 * on a full-JSON PUT (memberCount, coveragePercent, …) never reach a
 * controller.
 */
const Joi = require('joi');
const { RECORD_STATUS } = require('../config/constants');
const { collapse } = require('../utils/normalize');

const id = Joi.string().trim().min(1).max(64);
const version = Joi.number().integer().min(1);
const name = Joi.string()
  .trim()
  .min(1)
  .max(80)
  .custom((v) => collapse(v));
const notes = (max) => Joi.string().trim().allow('', null).max(max);
const place = Joi.string().trim().allow('').max(120);
const status = Joi.string().valid(...RECORD_STATUS);
const search = Joi.string().trim().allow('').max(80);

// ---- detachment groups ---------------------------------------------------------

const groupList = Joi.object({ query: search });

const groupCreate = Joi.object({
  name: name.required(),
  notes: notes(500),
});

/** PUT = the whole editable record: an absent `notes` clears it; `status` absent = unchanged. */
const groupPut = Joi.object({
  id,
  name: name.required(),
  notes: notes(500),
  status,
  version,
});

const groupPatch = Joi.object({
  id,
  name,
  notes: notes(500),
  status,
  version,
});

// ---- detachments ---------------------------------------------------------------

const detachmentList = Joi.object({
  detachmentGroupId: id,
  filter: Joi.string().valid('active', 'archived', 'all'),
  query: search,
});

const detachmentCreate = Joi.object({
  detachmentGroupId: id.required(),
  name: name.required(),
  region: place.default(''),
  mainCenter: place.default(''),
  notes: notes(1000),
});

/**
 * PUT = the whole editable record: region/mainCenter default to '' and an
 * absent `notes` clears it. `status` and `detachmentGroupId` are structural —
 * absent means unchanged.
 */
const detachmentPut = Joi.object({
  id,
  detachmentGroupId: id,
  name: name.required(),
  region: place.default(''),
  mainCenter: place.default(''),
  notes: notes(1000),
  status,
  version,
});

const detachmentPatch = Joi.object({
  id,
  detachmentGroupId: id,
  name,
  region: place,
  mainCenter: place,
  notes: notes(1000),
  status,
  version,
});

const lifecycleCommand = Joi.object({ version });

const statsQuery = Joi.object({
  days: Joi.number().integer().min(7).max(90).default(7),
});

const rosterQuery = Joi.object({
  includeInactive: Joi.boolean().truthy('1').falsy('0').default(false),
});

// ---- home / notifications / search -------------------------------------------------

const detachmentQuery = Joi.object({
  detachmentId: id.required(),
});

const notificationIds = Joi.object({
  ids: Joi.array().items(Joi.string().trim().min(1).max(200)).min(1).max(500).required(),
});

const SEARCH_TYPES = ['member', 'detachment', 'shift', 'item'];

const searchQuery = Joi.object({
  q: Joi.string().trim().min(1).max(80).required(),
  types: Joi.string()
    .trim()
    .custom((v, helpers) => {
      const list = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
      if (!list.length || list.some((t) => !SEARCH_TYPES.includes(t))) return helpers.error('any.invalid');
      return list;
    })
    .messages({ 'any.invalid': `types must be a comma-separated subset of ${SEARCH_TYPES.join(', ')}` }),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

module.exports = {
  groupList,
  groupCreate,
  groupPut,
  groupPatch,
  detachmentList,
  detachmentCreate,
  detachmentPut,
  detachmentPatch,
  lifecycleCommand,
  statsQuery,
  rosterQuery,
  detachmentQuery,
  notificationIds,
  searchQuery,
  SEARCH_TYPES,
};
