/**
 * Joi schemas — tenant administration (/settings, /tenant).
 * See docs/api/tenant-administration.md.
 */
const Joi = require('joi');
const { REASON_MAX, DISPLAY_NAME_MAX } = require('../config/constants');

const bool = () => Joi.boolean().strict().required();
const revision = () => Joi.number().integer().min(1).required();
const platformOwned = () => Joi.any().forbidden().messages({ 'any.unknown': 'This field is platform-owned and cannot be edited here.' });

// ---- /settings --------------------------------------------------------------------

/** PUT /settings/notifications — the FULL object, every flag a real boolean. */
const notificationPrefs = Joi.object({
  shiftReminders: bool(),
  stockAlerts: bool(),
  workshopUpdates: bool(),
  joinRequests: bool(),
});

/** PATCH /settings/organization — the tenant-editable profile only. */
const organizationPatch = Joi.object({
  legalName: Joi.string().trim().max(160).allow(''),
  address: Joi.string().trim().max(300).allow(''),
  emailPublic: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
  // The display name and Team Code belong to the control plane.
  name: platformOwned(),
  displayName: platformOwned(),
  teamCode: platformOwned(),
})
  .min(1)
  .messages({ 'object.min': 'Send at least one of legalName, address, emailPublic.' });

// ---- /tenant simple admins -----------------------------------------------------------

const capabilityKeys = () => Joi.array().items(Joi.string().trim().min(1).max(80)).min(1).unique().required();
const detachmentIds = () => Joi.array().items(Joi.string().trim().min(1).max(80)).unique().max(200);

/** POST /tenant/simple-admin-invitations. `email` is accepted as an alias of `invitedEmail`. */
const invitation = Joi.object({
  invitedEmail: Joi.string().trim().max(254),
  email: Joi.string().trim().max(254),
  suggestedName: Joi.string().trim().min(1).max(DISPLAY_NAME_MAX).required(),
  capabilityKeys: capabilityKeys(),
  detachmentIds: detachmentIds(),
  expectedRevision: revision(),
})
  .or('invitedEmail', 'email')
  .messages({ 'object.missing': 'invitedEmail is required.' });

const expectedRevisionOnly = Joi.object({ expectedRevision: revision() });

const capabilitiesPatch = Joi.object({
  capabilityKeys: capabilityKeys(),
  detachmentIds: detachmentIds(),
  expectedRevision: revision(),
});

const suspend = Joi.object({ reason: Joi.string().trim().max(REASON_MAX).allow('') });

module.exports = {
  notificationPrefs,
  organizationPatch,
  invitation,
  expectedRevisionOnly,
  capabilitiesPatch,
  suspend,
};
