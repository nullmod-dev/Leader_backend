/**
 * /tenant/organization and /tenant/features — the tenant-plane read of the
 * session's OWN organisation (Flutter OrganizationSnapshot, Point 15) and of
 * its module flags.
 *
 * Never part of this read: the Team Code, any version token, a suspension or
 * deletion reason, history, a price, or the Main Admin's login email/state.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { FEATURE_KEYS } = require('../../config/constants');
const { Account } = require('../../models');
const usageService = require('../../services/usageService');
const { iso } = require('../../utils/time');

exports.getOrganization = catchAsync(async (req, res) => {
  const { tenant } = req;
  // Organisation-wide usage figures are gated by org.edit (CAPABILITIES.md).
  const usageIncluded = caps.can(req.grant, 'org.edit');
  const [{ plan, rows }, mainAdmin] = await Promise.all([
    usageService.limitRows(tenant, { includeUsage: usageIncluded }),
    tenant.seat && tenant.seat.currentAccountId ? Account.findById(tenant.seat.currentAccountId).select('name') : null,
  ]);

  const sub = tenant.subscription || {};
  const subscription = { status: sub.status || 'trial', planId: plan ? String(plan._id) : sub.planId || null };
  ['trialEndsAt', 'renewsAt', 'graceEndsAt'].forEach((k) => {
    if (sub[k]) subscription[k] = iso(sub[k]);
  });

  const out = {
    organization: {
      tenantId: String(tenant._id),
      displayName: tenant.displayName,
      lifecycleStatus: tenant.lifecycle.status,
      createdAt: iso(tenant.createdAt),
    },
  };
  if (mainAdmin) out.mainAdmin = { displayName: mainAdmin.name || '' };
  out.subscription = subscription;
  out.limits = { usageIncluded, items: rows };
  out.readAt = new Date().toISOString();
  res.json(out);
});

exports.getFeatures = (req, res) => {
  res.json({
    features: FEATURE_KEYS.map((key) => ({ key, enabled: req.tenant.featureEnabled(key) })),
    readAt: new Date().toISOString(),
  });
};
