/**
 * /platform/tenants/:tenantId/features — the Point 8 per-tenant module switches
 * (screen: tenant detail → features). Each row carries its own `version`.
 * Disabling a module removes access only: no module data is ever deleted.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { FEATURE_KEYS } = require('../../config/constants');
const { withTransaction } = require('../../services/txn');
const auditService = require('../../services/auditService');
const lifecycleService = require('../../services/tenantLifecycleService');
const { serializeFeature } = require('../../services/tenantView');

const loadTenant = (tenantId, session) =>
  lifecycleService.loadTenant(tenantId, { session, missingCode: 'tenant_not_found', tombstoneCode: null });

/** Rows in catalogue order; a key with no stored row is simply absent (= disabled). */
const rowsOf = (tenant) =>
  FEATURE_KEYS.map((key) => (tenant.features || []).find((f) => f.key === key))
    .filter(Boolean)
    .map(serializeFeature);

/** GET /platform/tenants/:tenantId/features */
exports.list = catchAsync(async (req, res) => {
  const tenant = await loadTenant(req.params.tenantId);
  res.json({ tenantId: String(tenant._id), tenantName: tenant.displayName, features: rowsOf(tenant) });
});

/** PATCH /platform/tenants/:tenantId/features/:featureKey { enabled, expectedVersion } (idem) */
exports.update = catchAsync(async (req, res) => {
  const actor = req.auth.account;
  const { featureKey } = req.params;
  const { enabled, expectedVersion } = req.body;

  const row = await withTransaction(async (session) => {
    const tenant = await loadTenant(req.params.tenantId, session);
    if (!FEATURE_KEYS.includes(featureKey)) {
      throw new AppError('invalid_feature', 422, `Unknown feature ${featureKey}.`, { fields: { featureKey: 'Unknown feature key.' } });
    }
    const feature = (tenant.features || []).find((f) => f.key === featureKey);
    if (!feature) throw new AppError('feature_not_found', 404, 'No feature state exists for this key.');
    if (feature.version !== expectedVersion) {
      throw new AppError('stale_feature_state', 409, 'The feature changed since you read it.', {
        currentVersion: feature.version,
        currentRecord: serializeFeature(feature),
      });
    }
    // Same value → nothing moves: no new version, no audit event.
    if (feature.enabled === enabled) return serializeFeature(feature);

    const before = feature.enabled === true;
    feature.enabled = enabled;
    feature.version += 1;
    feature.updatedAt = new Date();
    await tenant.save({ session });
    await auditService.record({
      action: 'feature_flag_changed',
      actor,
      target: { type: 'tenant_feature', id: featureKey },
      tenant,
      changes: [{ field: 'feature_enabled', before, after: enabled }],
      session,
    });
    return serializeFeature(feature);
  });

  res.json(row);
});
