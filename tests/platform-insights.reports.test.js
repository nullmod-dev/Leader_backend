/**
 * Platform insights — GET /platform/reports/* (Point 13A contract).
 */
const f = require('./helpers/factory');
const auditService = require('../services/auditService');
const reportService = require('../services/reportService');
const { PLAN_LIMIT_KEYS, FEATURE_KEYS } = require('../config/constants');

const DAY = 86400000;
let platform;
const r = {};
const NOW = Date.now();

const get = (report, query = {}) => f.api().get(`/api/v1/platform/reports/${report}`).query(query).set(f.auth(platform.token));
const sum = (buckets) => buckets.reduce((n, b) => n + b.count, 0);
const ids = (body) => body.rows.items.map((row) => row.tenant.id);

beforeAll(async () => {
  platform = await f.superAdmin();
  const allOn = (except = {}) =>
    FEATURE_KEYS.filter((key) => except[key] !== 'missing').map((key) => ({ key, enabled: except[key] !== false, version: 1, updatedAt: new Date() }));

  r.r1 = await f.createTenant({
    displayName: 'ألف',
    subscription: { status: 'active', planId: 'mtm_core', renewsAt: new Date(NOW + 100 * DAY), limitOverrides: { members: 1 } },
  });
  const det = await f.detachment(r.r1);
  await f.member(r.r1, det);
  await f.member(r.r1, det);

  r.r2 = await f.createTenant({
    displayName: 'باء',
    subscription: { status: 'trial', planId: 'mtm_core', trialEndsAt: new Date(NOW + 5 * DAY), limitOverrides: { detachment_groups: 1 } },
    features: allOn({ inventory: false }),
  });
  await f.group(r.r2);

  r.r3 = await f.createTenant({ displayName: 'تاء', subscription: { status: 'trial', planId: null, trialEndsAt: new Date(NOW + 2 * DAY), limitOverrides: { members: 3 } } });
  r.r4 = await f.createTenant({
    displayName: 'ثاء',
    subscription: { status: 'grace', planId: 'mtm_standard', graceEndsAt: new Date(NOW + 10 * DAY) },
    lifecycle: { status: 'suspended' },
  });
  r.r5 = await f.createTenant({
    displayName: 'جيم',
    subscription: { status: 'inactive', planId: 'mtm_standard' },
    lifecycle: { status: 'deletion_pending', deletion: { requestedAt: new Date(), scheduledFor: new Date(NOW + 30 * DAY), reason: 'سبب داخلي' } },
  });
  r.r6 = await f.createTenant({
    displayName: 'حاء',
    subscription: { status: 'active', planId: 'mtm_advanced', renewsAt: new Date(NOW + DAY) },
    features: allOn({ workshops: 'missing' }),
  });
  r.deleted = await f.createTenant({ displayName: 'محذوف', lifecycle: { status: 'deleted' }, subscription: { status: 'active', planId: 'mtm_core' } });
});

beforeEach(() => reportService.clearSnapshots());

describe('GET /platform/reports/subscriptions', () => {
  test('envelope, summary invariants and row order', async () => {
    const { body } = await get('subscriptions').expect(200);
    expect(body.type).toBe('subscriptions');
    expect(body.generatedAt).toMatch(/Z$/);
    expect(typeof body.snapshotId).toBe('string');
    expect(body.rows.nextCursor).toBeNull();

    const s = body.summary;
    expect(s.tenantCount).toBe(6);
    expect(sum(s.byStatus)).toBe(6);
    expect(sum(s.byLifecycle)).toBe(6);
    expect(sum(s.byPlan)).toBe(6);
    expect(s.byStatus).toEqual([
      { key: 'active', count: 2 },
      { key: 'trial', count: 2 },
      { key: 'grace', count: 1 },
      { key: 'inactive', count: 1 },
    ]);
    expect(s.byLifecycle).toEqual([
      { key: 'active', count: 4 },
      { key: 'suspended', count: 1 },
      { key: 'deletion_pending', count: 1 },
    ]);
    expect(s.byPlan).toEqual([
      { plan: { id: 'mtm_core', name: 'ليدر الأساسية' }, count: 2 },
      { plan: { id: 'mtm_standard', name: 'ليدر القياسية' }, count: 2 },
      { plan: { id: 'mtm_advanced', name: 'ليدر المتقدمة' }, count: 1 },
      { plan: null, count: 1 },
    ]);

    // relevantDate asc, no date last; the deleted tenant is never a row.
    expect(ids(body)).toEqual([r.r6, r.r3, r.r2, r.r4, r.r1, r.r5].map((t) => String(t._id)));
    const first = body.rows.items[0];
    expect(first).toEqual({
      tenant: { id: String(r.r6._id), displayName: 'حاء' },
      lifecycle: 'active',
      subscriptionStatus: 'active',
      plan: { id: 'mtm_advanced', name: 'ليدر المتقدمة' },
      relevantDate: r.r6.subscription.renewsAt.toISOString(),
    });
    expect(body.rows.items[5].relevantDate).toBeNull();
  });

  test('filters: status, noPlan, planId, lifecycle, dueBefore', async () => {
    expect(ids((await get('subscriptions', { status: 'trial' })).body)).toEqual([String(r.r3._id), String(r.r2._id)]);
    expect(ids((await get('subscriptions', { noPlan: 'true' })).body)).toEqual([String(r.r3._id)]);
    expect(ids((await get('subscriptions', { planId: 'mtm_standard' })).body)).toEqual([String(r.r4._id), String(r.r5._id)]);
    const lifecycle = (await get('subscriptions', { lifecycle: 'suspended,deletion_pending' })).body;
    expect(ids(lifecycle)).toEqual([String(r.r4._id), String(r.r5._id)]);
    expect(lifecycle.summary.tenantCount).toBe(2);
    expect(sum(lifecycle.summary.byPlan)).toBe(2);
    const due = (await get('subscriptions', { dueBefore: new Date(NOW + 6 * DAY).toISOString() })).body;
    expect(ids(due)).toEqual([r.r6, r.r3, r.r2].map((t) => String(t._id)));
    expect(sum(due.summary.byStatus)).toBe(due.summary.tenantCount);
  });

  test('snapshot-bound paging: same snapshot, every row exactly once', async () => {
    const full = ids((await get('subscriptions', { limit: 100 })).body);
    const seen = [];
    let cursor;
    let snapshotId;
    let summary;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const { body } = await get('subscriptions', { limit: 2, ...(cursor ? { cursor } : {}) }).expect(200);
      if (!snapshotId) ({ snapshotId, summary } = body);
      expect(body.snapshotId).toBe(snapshotId);
      expect(body.summary).toEqual(summary);
      seen.push(...ids(body));
      cursor = body.rows.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(full);
  });

  test('a cursor whose snapshot is gone → 409 report_cursor_expired', async () => {
    const page1 = (await get('subscriptions', { limit: 2 }).expect(200)).body;
    reportService.clearSnapshots();
    const res = await get('subscriptions', { limit: 2, cursor: page1.rows.nextCursor }).expect(409);
    expect(res.body.error.code).toBe('report_cursor_expired');
  });

  test('LRU keeps at most 8 snapshots: the oldest cursor expires after 8 newer reports', async () => {
    const oldest = (await get('subscriptions', { limit: 1 }).expect(200)).body;
    for (let i = 0; i < reportService.SNAPSHOT_MAX; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await get('subscriptions', { limit: 1 }).expect(200);
    }
    expect(reportService.snapshotCount()).toBe(reportService.SNAPSHOT_MAX);
    const res = await get('subscriptions', { limit: 1, cursor: oldest.rows.nextCursor }).expect(409);
    expect(res.body.error.code).toBe('report_cursor_expired');
  });

  test('a cursor from another report or filter, or malformed → 422 validation', async () => {
    const page1 = (await get('subscriptions', { limit: 2 }).expect(200)).body;
    const foreign = await get('usage-limits', { limit: 2, cursor: page1.rows.nextCursor }).expect(422);
    expect(foreign.body.error.code).toBe('validation');
    const refiltered = await get('subscriptions', { limit: 2, status: 'trial', cursor: page1.rows.nextCursor }).expect(422);
    expect(refiltered.body.error.code).toBe('validation');
    const malformed = await get('subscriptions', { cursor: 'garbage' }).expect(422);
    expect(malformed.body.error.fields).toHaveProperty('cursor');
  });

  test('closed parameters: unknown, bad values, planId + noPlan, deleted lifecycle → 422 validation', async () => {
    const unknown = await get('subscriptions', { foo: '1' }).expect(422);
    expect(unknown.body.error.code).toBe('validation');
    expect(unknown.body.error.fields).toHaveProperty('foo');
    expect((await get('subscriptions', { status: 'bogus' }).expect(422)).body.error.fields).toHaveProperty('status');
    await get('subscriptions', { planId: 'mtm_core', noPlan: 'true' }).expect(422);
    await get('subscriptions', { lifecycle: 'deleted' }).expect(422);
    await get('subscriptions', { limit: 0 }).expect(422);
    await get('subscriptions', { limit: 101 }).expect(422);
  });

  test('privacy: no Team Code, reason or deleted tenant anywhere', async () => {
    const text = JSON.stringify((await get('subscriptions', { limit: 100 })).body);
    Object.values(r).forEach((t) => expect(text).not.toContain(t.teamCode));
    expect(text).not.toContain('سبب داخلي');
    expect(text).not.toContain(String(r.deleted._id));
  });
});

describe('GET /platform/reports/usage-limits', () => {
  test('cells, bands, invariants and ranking', async () => {
    const { body } = await get('usage-limits').expect(200);
    expect(body.type).toBe('usage_limits');
    expect(body.summary.tenantCount).toBe(6);
    expect(body.summary.byKey.map((k) => k.key)).toEqual(PLAN_LIMIT_KEYS);
    body.summary.byKey.forEach((k) => expect(sum(k.bands)).toBe(6));
    const members = body.summary.byKey.find((k) => k.key === 'members').bands;
    expect(members).toEqual([
      { key: 'within_limit', count: 4 },
      { key: 'at_limit', count: 0 },
      { key: 'over_limit', count: 1 },
      { key: 'no_limit', count: 1 },
    ]);

    body.rows.items.forEach((row) => expect(row.cells.map((c) => c.key)).toEqual(PLAN_LIMIT_KEYS));
    // over → at → within (ratio desc, id asc) → none.
    const zeroUsage = [r.r4, r.r5, r.r6].map((t) => String(t._id)).sort();
    expect(ids(body)).toEqual([String(r.r1._id), String(r.r2._id), ...zeroUsage, String(r.r3._id)]);
    const r1 = body.rows.items[0];
    expect(r1.plan).toEqual({ id: 'mtm_core', name: 'ليدر الأساسية' });
    expect(r1.cells.find((c) => c.key === 'members')).toEqual({ key: 'members', usage: 2, limit: 1, overridden: true });
    expect(r1.cells.find((c) => c.key === 'detachments')).toEqual({ key: 'detachments', usage: 1, limit: 5, overridden: false });
    // No plan → every limit null and nothing reads as overridden (even with a stored override).
    const r3 = body.rows.items[5];
    expect(r3.plan).toBeNull();
    r3.cells.forEach((c) => expect(c).toMatchObject({ limit: null, overridden: false }));
  });

  test('band filter uses the worst band, or limitKey’s band', async () => {
    expect(ids((await get('usage-limits', { band: 'over_limit' })).body)).toEqual([String(r.r1._id)]);
    expect(ids((await get('usage-limits', { band: 'at_limit' })).body)).toEqual([String(r.r2._id)]);
    expect(ids((await get('usage-limits', { band: 'no_limit' })).body)).toEqual([String(r.r3._id)]);
    const within = (await get('usage-limits', { limitKey: 'members', band: 'within_limit' })).body;
    expect(ids(within).sort()).toEqual([r.r2, r.r4, r.r5, r.r6].map((t) => String(t._id)).sort());
    expect(within.summary.tenantCount).toBe(4);
    within.summary.byKey.forEach((k) => expect(sum(k.bands)).toBe(4));
  });

  test('limitKey ranks by that key', async () => {
    const { body } = await get('usage-limits', { limitKey: 'detachment_groups' }).expect(200);
    // r2 at limit (1/1), then r1 (1/2 = 0.5), then zero-usage rows, then no plan.
    expect(ids(body).slice(0, 2)).toEqual([String(r.r2._id), String(r.r1._id)]);
    expect(ids(body)[5]).toBe(String(r.r3._id));
  });

  test('bad limitKey / band → 422 validation', async () => {
    await get('usage-limits', { limitKey: 'nope' }).expect(422);
    await get('usage-limits', { band: 'near_limit' }).expect(422);
  });
});

describe('GET /platform/reports/feature-availability', () => {
  test('states per module, unsupported bucket, Arabic order', async () => {
    const { body } = await get('feature-availability').expect(200);
    expect(body.type).toBe('feature_availability');
    expect(body.summary.tenantCount).toBe(6);
    expect(body.summary.byFeature.map((x) => x.key)).toEqual(FEATURE_KEYS);
    body.summary.byFeature.forEach((x) => expect(sum(x.states)).toBe(6));
    expect(body.summary.byFeature.find((x) => x.key === 'inventory').states).toEqual([
      { key: 'enabled', count: 5 },
      { key: 'disabled', count: 1 },
    ]);
    expect(body.summary.byFeature.find((x) => x.key === 'workshops').states).toEqual([
      { key: 'enabled', count: 5 },
      { key: 'disabled', count: 0 },
      { key: 'unsupported', count: 1 },
    ]);
    expect(ids(body)).toEqual([r.r1, r.r2, r.r3, r.r4, r.r5, r.r6].map((t) => String(t._id)));
    const r6 = body.rows.items[5];
    expect(r6.features.find((x) => x.key === 'workshops')).toEqual({ key: 'workshops', state: 'unsupported' });
    expect(r6).toEqual({ tenant: { id: String(r.r6._id), displayName: 'حاء' }, lifecycle: 'active', features: expect.any(Array) });
  });

  test('featureKey + state filter; state alone is invalid', async () => {
    expect(ids((await get('feature-availability', { featureKey: 'inventory', state: 'disabled' })).body)).toEqual([String(r.r2._id)]);
    const on = (await get('feature-availability', { featureKey: 'workshops', state: 'enabled' })).body;
    expect(on.summary.tenantCount).toBe(5);
    expect(ids(on)).not.toContain(String(r.r6._id));
    const bad = await get('feature-availability', { state: 'enabled' }).expect(422);
    expect(bad.body.error.code).toBe('validation');
  });
});

describe('GET /platform/reports/platform-activity', () => {
  beforeAll(async () => {
    const ago = (days) => new Date(NOW - days * DAY);
    await auditService.record({ action: 'tenant_registered', actor: platform.account, tenant: r.r1, occurredAt: ago(2) });
    await auditService.record({ action: 'plan_changed', actor: platform.account, tenant: r.r1, occurredAt: ago(3) });
    await auditService.record({ action: 'break_glass_activated', actor: platform.account, tenant: r.r1, occurredAt: ago(1) });
    await auditService.record({ action: 'commerce_offer_created', actor: platform.account, occurredAt: ago(1) });
    await auditService.record({ action: 'tenant_registered', actor: platform.account, tenant: r.r2, occurredAt: ago(40) });
    await auditService.record({ action: 'admin_invitation_created', stream: 'tenant', actor: platform.account, tenant: r.r1, occurredAt: ago(1) });
  });

  const count = (body, key) => (body.byAction.find((b) => b.key === key) || {}).count;

  test('default range: last 30 days, counts only, full catalogue with zeros', async () => {
    const { body } = await get('platform-activity').expect(200);
    expect(Object.keys(body).sort()).toEqual(['byAction', 'evidenceAvailableFrom', 'generatedAt', 'range', 'snapshotId', 'type']);
    expect(body.type).toBe('platform_activity');
    expect(body.evidenceAvailableFrom).toBeNull();
    expect(Date.parse(body.range.before) - Date.parse(body.range.from)).toBe(30 * DAY);
    expect(count(body, 'tenant_registered')).toBe(1);
    expect(count(body, 'plan_changed')).toBe(1);
    expect(count(body, 'break_glass_activated')).toBe(1);
    expect(count(body, 'commerce_offer_created')).toBe(1);
    expect(count(body, 'main_admin_setup_resent')).toBe(0);
    expect(count(body, 'customer_demo_session_started')).toBe(0);
    expect(count(body, 'admin_invitation_created')).toBeUndefined();
    expect(count(body, 'plan_created')).toBeUndefined();
    expect(new Set(body.byAction.map((b) => b.key)).size).toBe(body.byAction.length);
  });

  test('explicit range echoes exactly and agrees with the Audit read', async () => {
    const from = new Date(NOW - 45 * DAY).toISOString();
    const before = new Date(NOW).toISOString();
    const { body } = await get('platform-activity', { from, before }).expect(200);
    expect(body.range).toEqual({ from, before });
    expect(count(body, 'tenant_registered')).toBe(2);
    const audit = await f.api().get('/api/v1/platform/audit').query({ from, before, action: 'tenant_registered' }).set(f.auth(platform.token)).expect(200);
    expect(audit.body.items).toHaveLength(2);
  });

  test('category filter keeps only that category', async () => {
    const { body } = await get('platform-activity', { category: 'subscription' }).expect(200);
    expect(body.byAction.map((b) => b.key).sort()).toEqual(
      ['plan_changed', 'subscription_activated', 'subscription_moved_to_grace', 'trial_ended', 'trial_extended'].sort(),
    );
    expect(count(body, 'plan_changed')).toBe(1);
  });

  test('range errors: from ≥ before → validation; > 367 days → report_range_too_large', async () => {
    const same = new Date(NOW).toISOString();
    const eq = await get('platform-activity', { from: same, before: same }).expect(422);
    expect(eq.body.error.code).toBe('validation');

    const before = new Date('2026-09-01T00:00:00Z');
    const tooLarge = await get('platform-activity', { from: new Date(before - 367 * DAY - 1).toISOString(), before: before.toISOString() }).expect(422);
    expect(tooLarge.body.error.code).toBe('report_range_too_large');
    await get('platform-activity', { from: new Date(before - 367 * DAY).toISOString(), before: before.toISOString() }).expect(200);
  });

  test('no cursor, no unknown params, closed categories', async () => {
    expect((await get('platform-activity', { cursor: 'x' }).expect(422)).body.error.code).toBe('validation');
    await get('platform-activity', { limit: 5 }).expect(422);
    await get('platform-activity', { category: 'commerce' }).expect(422);
  });
});
