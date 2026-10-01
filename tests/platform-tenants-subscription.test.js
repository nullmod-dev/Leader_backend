/**
 * /platform/tenants/:tenantId/subscription/**, /limits/** and /features/**.
 */
const f = require('./helpers/factory');

const BASE = '/api/v1/platform/tenants';
const DAY = 86400000;

let sa;

beforeAll(async () => {
  await f.ensurePlans();
  await f.models.Plan.updateOne(
    { _id: 'mtm_legacy' },
    {
      $set: {
        name: 'ليدر القديمة',
        selectable: false,
        order: 9,
        defaultLimits: { detachment_groups: 1, detachments: 2, admins: 1, members: 10, workshops: 1, storage_bytes: 1000 },
      },
    },
    { upsert: true },
  );
  sa = await f.superAdmin();
});

const near = (value, expected, tolerance = 60000) => Math.abs(new Date(value).getTime() - expected) < tolerance;

const trialTenant = (extra = {}) =>
  f.createTenant({
    subscription: { status: 'trial', planId: null, version: 1, trialEndsAt: new Date(Date.now() + 5 * DAY) },
    ...extra,
  });

const post = (tenantId, path, payload, key) =>
  f
    .api()
    .post(`${BASE}/${tenantId}/subscription/${path}`)
    .set(f.auth(sa.token))
    .set(key ? { 'Idempotency-Key': key } : f.idem())
    .send(payload);

const patchLimit = (tenantId, key, payload) =>
  f.api().patch(`${BASE}/${tenantId}/limits/${key}`).set(f.auth(sa.token)).set(f.idem()).send(payload);

const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
};

describe('subscription reads', () => {
  test('GET /subscription → snapshot + resolved currentPlan (null for no plan)', async () => {
    const t = await trialTenant();
    const res = await f.api().get(`${BASE}/${t._id}/subscription`).set(f.auth(sa.token)).expect(200);
    expect(res.body.currentPlan).toBeNull();
    expect(res.body.subscription).toMatchObject({ status: 'trial', planId: null, version: 1, renewsAt: null, graceEndsAt: null, limitOverrides: {} });

    const withPlan = await f.createTenant();
    const res2 = await f.api().get(`${BASE}/${withPlan._id}/subscription`).set(f.auth(sa.token)).expect(200);
    expect(res2.body.currentPlan).toEqual({
      id: 'mtm_standard',
      name: 'ليدر القياسية',
      description: 'للفرق النشطة متعددة المفارز.',
      recommended: true,
      selectable: true,
      defaultLimits: { detachment_groups: 5, detachments: 15, admins: 8, members: 300, workshops: 40, storage_bytes: 21474836480 },
    });
  });

  test('an unresolvable planId → 409 plan_not_found; unknown tenant → 404 not_found', async () => {
    const t = await f.createTenant({ subscription: { status: 'active', planId: 'mtm_ghost', version: 1 } });
    expectError(await f.api().get(`${BASE}/${t._id}/subscription`).set(f.auth(sa.token)), 409, 'plan_not_found');
    expectError(await f.api().get(`${BASE}/saas_nope/subscription`).set(f.auth(sa.token)), 404, 'not_found');
  });

  test('GET /limits → plan, usage, effective and rows; no plan → 409 plan_not_found', async () => {
    const t = await f.createTenant({ subscription: { status: 'active', planId: 'mtm_core', version: 3, limitOverrides: { detachments: 9 } } });
    await f.detachment(t);
    const res = await f.api().get(`${BASE}/${t._id}/limits`).set(f.auth(sa.token)).expect(200);
    expect(res.body).toMatchObject({
      tenantId: String(t._id),
      tenantName: t.displayName,
      plan: { id: 'mtm_core', name: 'ليدر الأساسية' },
      subscription: { version: 3, limitOverrides: { detachments: 9 } },
    });
    expect(res.body.usage).toMatchObject({ detachment_groups: 1, detachments: 1, admins: 0, members: 0, workshops: 0, storage_bytes: 0 });
    expect(res.body.effective).toMatchObject({ detachments: 9, members: 75 });
    const row = res.body.rows.find((r) => r.key === 'detachments');
    expect(row).toEqual({ key: 'detachments', overridden: true, planDefault: 5, effective: 9, usage: 1 });
    expect(res.body.rows).toHaveLength(6);

    const none = await trialTenant();
    expectError(await f.api().get(`${BASE}/${none._id}/limits`).set(f.auth(sa.token)), 409, 'plan_not_found');
  });
});

describe('subscription commands', () => {
  test('activate trial → active with plan, renewsAt, event + audit; lifecycle untouched', async () => {
    const t = await trialTenant();
    const res = await post(t._id, 'activate', { planId: 'mtm_standard', expectedVersion: 1 }).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'active', planId: 'mtm_standard', version: 2, trialEndsAt: null, graceEndsAt: null });
    expect(near(res.body.subscription.renewsAt, Date.now() + 365 * DAY)).toBe(true);
    expect(res.body.currentPlan.id).toBe('mtm_standard');

    const fresh = await f.models.SaasTenant.findById(t._id);
    expect(fresh.lifecycle.version).toBe(1);
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: String(t._id), type: 'subscription_activated' })).toBe(1);
    const audit = await f.models.AuditEvent.findOne({ action: 'subscription_activated', 'tenant.id': String(t._id) });
    expect(audit.category).toBe('subscription');
    expect(audit.changes.map((c) => c.field)).toEqual(['subscription_status', 'plan_assignment']);

    expectError(await post(t._id, 'activate', { planId: 'mtm_core', expectedVersion: 2 }), 409, 'invalid_subscription_transition');
  });

  test('plan validity is checked before the version; unselectable plans refuse new selections', async () => {
    const t = await trialTenant();
    expectError(await post(t._id, 'activate', { planId: 'mtm_nope', expectedVersion: 99 }), 404, 'plan_not_found');
    expectError(await post(t._id, 'activate', { planId: 'mtm_legacy', expectedVersion: 1 }), 409, 'plan_unavailable');
    const stale = await post(t._id, 'activate', { planId: 'mtm_core', expectedVersion: 99 });
    expectError(stale, 409, 'stale_subscription');
    expect(stale.body.error.currentVersion).toBe(1);
    expectError(await post('saas_nope', 'activate', { planId: 'mtm_core', expectedVersion: 1 }), 404, 'not_found');
    const invalid = await post(t._id, 'activate', { expectedVersion: 1 });
    expectError(invalid, 422, 'validation');
    expect(invalid.body.error.fields.planId).toBeDefined();
  });

  test('trial/extend: later than now and the current end, trial only', async () => {
    const t = await trialTenant();
    const newEndsAt = new Date(Date.now() + 20 * DAY).toISOString();
    const res = await post(t._id, 'trial/extend', { newEndsAt, expectedVersion: 1 }).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'trial', version: 2, trialEndsAt: newEndsAt });

    expectError(await post(t._id, 'trial/extend', { newEndsAt: new Date(Date.now() - DAY).toISOString(), expectedVersion: 2 }), 422, 'invalid_trial_extension');
    expectError(await post(t._id, 'trial/extend', { newEndsAt: new Date(Date.now() + 10 * DAY).toISOString(), expectedVersion: 2 }), 422, 'invalid_trial_extension');
    expectError(await post(t._id, 'trial/extend', { newEndsAt: 'tomorrow', expectedVersion: 2 }), 422, 'validation');

    const active = await f.createTenant();
    expectError(await post(active._id, 'trial/extend', { newEndsAt, expectedVersion: 1 }), 409, 'invalid_subscription_transition');
  });

  test('trial/end → grace by the configured grace window', async () => {
    const t = await trialTenant();
    const res = await post(t._id, 'trial/end', { expectedVersion: 1 }).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'grace', version: 2, trialEndsAt: null });
    expect(near(res.body.subscription.graceEndsAt, Date.now() + 14 * DAY)).toBe(true);
    expectError(await post(t._id, 'trial/end', { expectedVersion: 2 }), 409, 'invalid_subscription_transition');

    // grace → activate is legal
    const back = await post(t._id, 'activate', { planId: 'mtm_core', expectedVersion: 2 }).expect(200);
    expect(back.body.subscription).toMatchObject({ status: 'active', planId: 'mtm_core', graceEndsAt: null });
  });

  test('grace: active only; renewsAt cleared', async () => {
    const t = await f.createTenant();
    const res = await post(t._id, 'grace', { expectedVersion: 1 }).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'grace', version: 2, renewsAt: null, planId: 'mtm_standard' });
    expect(await f.models.AuditEvent.exists({ action: 'subscription_moved_to_grace', 'tenant.id': String(t._id) })).not.toBeNull();
    expect(await f.models.TenantStatusEvent.exists({ tenantId: String(t._id), type: 'moved_to_grace' })).not.toBeNull();
    expectError(await post(t._id, 'grace', { expectedVersion: 2 }), 409, 'invalid_subscription_transition');
  });

  test('plan change: any status; same plan / unknown / unselectable refused', async () => {
    const t = await f.createTenant();
    const res = await post(t._id, 'plan', { planId: 'mtm_advanced', expectedVersion: 1 }).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'active', planId: 'mtm_advanced', version: 2 });
    expect(res.body.currentPlan.id).toBe('mtm_advanced');
    expectError(await post(t._id, 'plan', { planId: 'mtm_advanced', expectedVersion: 2 }), 409, 'invalid_subscription_transition');
    expectError(await post(t._id, 'plan', { planId: 'mtm_nope', expectedVersion: 2 }), 404, 'plan_not_found');
    expectError(await post(t._id, 'plan', { planId: 'mtm_legacy', expectedVersion: 2 }), 409, 'plan_unavailable');
    const audit = await f.models.AuditEvent.findOne({ action: 'plan_changed', 'tenant.id': String(t._id) });
    expect(audit.changes[0]).toMatchObject({ field: 'plan_assignment', before: { value: 'mtm_standard' }, after: { value: 'mtm_advanced' } });

    const trial = await trialTenant();
    const assigned = await post(trial._id, 'plan', { planId: 'mtm_core', expectedVersion: 1 }).expect(200);
    expect(assigned.body.subscription).toMatchObject({ status: 'trial', planId: 'mtm_core' });
  });

  test('idempotent replay of a subscription command', async () => {
    const t = await f.createTenant();
    const key = `sub-${f.uniq()}`;
    const first = await post(t._id, 'grace', { expectedVersion: 1 }, key).expect(200);
    const again = await post(t._id, 'grace', { expectedVersion: 1 }, key).expect(200);
    expect(again.body).toEqual(first.body);
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: String(t._id), type: 'moved_to_grace' })).toBe(1);
    expectError(await post(t._id, 'grace', { expectedVersion: 2 }, key), 409, 'idempotency_conflict');
  });
});

describe('PATCH /limits/:limitKey', () => {
  test('sets and removes an override; returns the limits projection', async () => {
    const t = await f.createTenant();
    const set = await patchLimit(t._id, 'members', { overrideValue: 20, expectedVersion: 1 }).expect(200);
    expect(set.body.subscription).toEqual({ version: 2, limitOverrides: { members: 20 } });
    expect(set.body.effective.members).toBe(20);
    expect(set.body.rows.find((r) => r.key === 'members')).toMatchObject({ overridden: true, planDefault: 300, effective: 20 });
    const audit = await f.models.AuditEvent.findOne({ action: 'limit_override_changed', 'tenant.id': String(t._id) });
    expect(audit).toMatchObject({ category: 'entitlement', target: { type: 'tenant_limit', id: 'members' } });
    expect(audit.changes[0].after).toMatchObject({ kind: 'integer', value: 20 });

    const zero = await patchLimit(t._id, 'members', { overrideValue: 0, expectedVersion: 2 }).expect(200);
    expect(zero.body.effective.members).toBe(0);

    const cleared = await patchLimit(t._id, 'members', { overrideValue: null, expectedVersion: 3 }).expect(200);
    expect(cleared.body.subscription).toEqual({ version: 4, limitOverrides: {} });
    expect(cleared.body.effective.members).toBe(300);
    const reread = await f.api().get(`${BASE}/${t._id}/limits`).set(f.auth(sa.token)).expect(200);
    expect(reread.body.subscription).toEqual({ version: 4, limitOverrides: {} });
    const detail = await f.api().get(`${BASE}/${t._id}`).set(f.auth(sa.token)).expect(200);
    expect(detail.body.subscription).toMatchObject({ version: 4, limitOverrides: {} });
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: String(t._id), type: 'limit_override_changed' })).toBe(3);
  });

  test('refusals: limit_invalid, plan_not_found, stale_subscription, validation', async () => {
    const t = await f.createTenant();
    for (const [key, value] of [['nope', 5], ['members', -1], ['members', 2.5], ['members', '5'], ['members', undefined]]) {
      // eslint-disable-next-line no-await-in-loop
      expectError(await patchLimit(t._id, key, { overrideValue: value, expectedVersion: 1 }), 422, 'limit_invalid');
    }
    expectError(await patchLimit(t._id, 'members', { overrideValue: 5, expectedVersion: 9 }), 409, 'stale_subscription');
    expectError(await patchLimit(t._id, 'members', { overrideValue: 5 }), 422, 'validation');
    const none = await trialTenant();
    expectError(await patchLimit(none._id, 'members', { overrideValue: 5, expectedVersion: 1 }), 409, 'plan_not_found');
    expectError(await patchLimit('saas_nope', 'members', { overrideValue: 5, expectedVersion: 1 }), 404, 'not_found');
  });
});

describe('features', () => {
  test('GET → the four rows with versions', async () => {
    const t = await f.createTenant();
    const res = await f.api().get(`${BASE}/${t._id}/features`).set(f.auth(sa.token)).expect(200);
    expect(res.body.tenantId).toBe(String(t._id));
    expect(res.body.tenantName).toBe(t.displayName);
    expect(res.body.features.map((x) => x.key)).toEqual(['inventory', 'statistics_reports', 'workshops', 'announcements']);
    expect(res.body.features[0]).toMatchObject({ enabled: true, version: 1 });
    expect(res.body.features[0].updatedAt).toMatch(/Z$/);
    expectError(await f.api().get(`${BASE}/saas_nope/features`).set(f.auth(sa.token)), 404, 'tenant_not_found');
  });

  test('PATCH toggles one row; disabling never deletes module data', async () => {
    const t = await f.createTenant();
    const w = await f.workshop(t);
    const res = await f
      .api()
      .patch(`${BASE}/${t._id}/features/workshops`)
      .set(f.auth(sa.token))
      .set(f.idem())
      .send({ enabled: false, expectedVersion: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ key: 'workshops', enabled: false, version: 2 });
    expect(await f.models.Workshop.exists({ _id: w._id })).not.toBeNull();
    const fresh = await f.models.SaasTenant.findById(t._id);
    expect(fresh.featureEnabled('workshops')).toBe(false);
    expect(fresh.features.find((x) => x.key === 'inventory').version).toBe(1);
    const audit = await f.models.AuditEvent.findOne({ action: 'feature_flag_changed', 'tenant.id': String(t._id) });
    expect(audit).toMatchObject({ category: 'entitlement', target: { type: 'tenant_feature', id: 'workshops' } });
    expect(audit.changes[0]).toMatchObject({ field: 'feature_enabled', before: { kind: 'bool', value: true }, after: { kind: 'bool', value: false } });
  });

  test('refusals: stale_feature_state, invalid_feature, feature_not_found, validation', async () => {
    const t = await f.createTenant({ features: [{ key: 'inventory', enabled: true, version: 3, updatedAt: new Date() }] });
    const patch = (key, payload) => f.api().patch(`${BASE}/${t._id}/features/${key}`).set(f.auth(sa.token)).set(f.idem()).send(payload);
    const stale = await patch('inventory', { enabled: false, expectedVersion: 1 });
    expectError(stale, 409, 'stale_feature_state');
    expect(stale.body.error.currentVersion).toBe(3);
    expectError(await patch('teleport', { enabled: true, expectedVersion: 1 }), 422, 'invalid_feature');
    expectError(await patch('workshops', { enabled: true, expectedVersion: 1 }), 404, 'feature_not_found');
    expectError(await patch('inventory', { enabled: 'yes', expectedVersion: 3 }), 422, 'validation');
    expectError(
      await f.api().patch(`${BASE}/saas_nope/features/inventory`).set(f.auth(sa.token)).set(f.idem()).send({ enabled: true, expectedVersion: 1 }),
      404,
      'tenant_not_found',
    );
  });
});
