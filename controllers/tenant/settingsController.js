/**
 * /settings — the signed-in account's notification preferences and the
 * tenant's editable organisation profile (Flutter SettingsRepository:
 * NotificationPrefs, OrgInfo).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const { Account, SaasTenant, Detachment, TeamMember } = require('../../models');
const storageService = require('../../services/storageService');
const { fileUrl } = require('../../services/sessionView');

const PREF_KEYS = ['shiftReminders', 'stockAlerts', 'workshopUpdates', 'joinRequests'];
const PREF_DEFAULTS = { shiftReminders: true, stockAlerts: true, workshopUpdates: true, joinRequests: false };

const prefsJson = (account) => {
  const p = account.notificationPrefs || {};
  const out = {};
  PREF_KEYS.forEach((k) => {
    out[k] = typeof p[k] === 'boolean' ? p[k] : PREF_DEFAULTS[k];
  });
  return out;
};

/** OrgInfo: { name, legalName, address, emailPublic, detachmentCount, memberCount, logoUrl? } */
const orgInfo = async (tenant) => {
  const tenantId = String(tenant._id);
  const [detachmentCount, memberCount] = await Promise.all([
    Detachment.countDocuments({ tenantId, status: 'active' }),
    TeamMember.countDocuments({ tenantId, active: true }),
  ]);
  const org = tenant.org || {};
  const out = {
    name: tenant.displayName,
    legalName: org.legalName || '',
    address: org.address || '',
    emailPublic: org.emailPublic || '',
    detachmentCount,
    memberCount,
  };
  const logoUrl = fileUrl(org.logoPath);
  if (logoUrl) out.logoUrl = logoUrl;
  return out;
};

// ---- notifications (any full session) ---------------------------------------------

exports.getNotifications = (req, res) => {
  res.json(prefsJson(req.auth.account));
};

exports.putNotifications = catchAsync(async (req, res) => {
  const set = {};
  PREF_KEYS.forEach((k) => {
    set[`notificationPrefs.${k}`] = req.body[k];
  });
  const account = await Account.findByIdAndUpdate(req.auth.account._id, { $set: set }, { new: true });
  res.json(prefsJson(account));
});

// ---- organisation profile (tenant) ----------------------------------------------------

exports.getOrganization = catchAsync(async (req, res) => {
  res.json(await orgInfo(req.tenant));
});

exports.patchOrganization = catchAsync(async (req, res) => {
  const set = {};
  ['legalName', 'address', 'emailPublic'].forEach((k) => {
    if (req.body[k] !== undefined) set[`org.${k}`] = req.body[k];
  });
  const tenant = await SaasTenant.findByIdAndUpdate(req.tenantId, { $set: set }, { new: true });
  res.json(await orgInfo(tenant));
});

exports.uploadLogo = catchAsync(async (req, res) => {
  const previous = req.tenant.org && req.tenant.org.logoPath;
  const saved = await storageService.saveImage(req.file.buffer, 'tenantLogo', {
    ownerType: 'tenant',
    ownerId: req.tenantId,
    tenantId: req.tenantId,
  });
  const tenant = await SaasTenant.findByIdAndUpdate(req.tenantId, { $set: { 'org.logoPath': saved.path } }, { new: true });
  if (previous && previous !== saved.path) await storageService.removeFile(previous);
  res.json(await orgInfo(tenant));
});

exports.deleteLogo = catchAsync(async (req, res) => {
  const previous = req.tenant.org && req.tenant.org.logoPath;
  const tenant = await SaasTenant.findByIdAndUpdate(req.tenantId, { $unset: { 'org.logoPath': 1 } }, { new: true });
  if (previous) await storageService.removeFile(previous);
  res.json(await orgInfo(tenant));
});

exports.prefsJson = prefsJson;
exports.orgInfo = orgInfo;
