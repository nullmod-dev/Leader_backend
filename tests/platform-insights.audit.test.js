/**
 * Platform insights — GET /platform/audit and GET /platform/audit/:eventId.
 */
const f = require('./helpers/factory');
const auditService = require('../services/auditService');
const cursorUtil = require('../utils/cursor');

let platform;
let otherAdmin;
let tenant;
let tenantEvent;
const events = [];
const T0 = new Date('2026-09-01T10:00:00.000Z').getTime();
const at = (hours) => new Date(T0 + hours * 3600000);

const list = (query = {}) => f.api().get('/api/v1/platform/audit').query(query).set(f.auth(platform.token));

beforeAll(async () => {
  platform = await f.superAdmin({ name: 'Leader Admin' });
  otherAdmin = await f.superAdmin({ name: 'مشرف ثانٍ' });
  tenant = await f.createTenant({ displayName: 'فرق الهلال الطبية' });

  const rec = async (p) => {
    const e = await auditService.record(p);
    events.push(e);
    return e;
  };
  await rec({ action: 'tenant_registered', actor: platform.account, target: { type: 'tenant', id: String(tenant._id), displayName: tenant.displayName }, tenant, occurredAt: at(0) });
  await rec({ action: 'plan_changed', actor: platform.account, target: { type: 'plan_assignment', id: 'mtm_core' }, tenant, changes: [{ field: 'plan_assignment', before: null, after: 'mtm_core' }], occurredAt: at(1) });
  await rec({ action: 'feature_flag_changed', actor: otherAdmin.account, target: { type: 'tenant_feature', id: 'inventory', displayName: 'Inventory' }, tenant, occurredAt: at(2) });
  await rec({ action: 'trial_ended', actor: { kind: 'system' }, target: { type: 'subscription', id: String(tenant._id) }, tenant, occurredAt: at(3) });
  // Two events at the same instant → _id breaks the tie.
  await rec({ action: 'tenant_suspended', actor: platform.account, target: { type: 'tenant_lifecycle', id: String(tenant._id) }, tenant, occurredAt: at(4) });
  await rec({ action: 'tenant_reactivated', actor: platform.account, target: { type: 'tenant_lifecycle', id: String(tenant._id) }, tenant, occurredAt: at(4) });
  await rec({ action: 'platform_settings_changed', actor: otherAdmin.account, target: { type: 'setting', id: 'demo.duration' }, occurredAt: at(5) });
  // Tenant stream: never on the platform read.
  tenantEvent = await auditService.record({ action: 'admin_invitation_created', stream: 'tenant', actor: platform.account, tenant, occurredAt: at(6) });
});

const expectedOrder = () =>
  [...events].sort((a, b) => b.occurredAt - a.occurredAt || (String(b._id) > String(a._id) ? 1 : -1)).map((e) => String(e._id));

describe('GET /platform/audit — list', () => {
  test('platform stream only, occurredAt desc then id desc', async () => {
    const res = await list().expect(200);
    expect(res.body.items.map((e) => e.id)).toEqual(expectedOrder());
    expect(res.body.nextCursor).toBeNull();
    const plan = res.body.items.find((e) => e.action === 'plan_changed');
    expect(plan).toMatchObject({
      category: 'subscription',
      actor: { kind: 'platform_administrator', id: String(platform.account._id), displayName: 'Leader Admin' },
      target: { type: 'plan_assignment', id: 'mtm_core' },
      tenant: { id: String(tenant._id), displayName: 'فرق الهلال الطبية', isDeleted: false },
      changes: [{ field: 'plan_assignment', after: { kind: 'text', value: 'mtm_core' } }],
    });
    // No internal fields leave the server.
    res.body.items.forEach((e) => {
      expect(e).not.toHaveProperty('stream');
      expect(e).not.toHaveProperty('tenantScopeId');
      expect(e).not.toHaveProperty('_id');
    });
    expect(res.body.items.find((e) => e.action === 'platform_settings_changed')).not.toHaveProperty('tenant');
  });

  test('cursor paging walks every event exactly once', async () => {
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await list({ limit: 2, ...(cursor ? { cursor } : {}) }).expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.items.map((e) => e.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expectedOrder());
    expect(pages).toBe(4);
  });

  test('filters: action, category, actorKind, actorId, tenantId, targetType', async () => {
    expect((await list({ action: 'plan_changed' })).body.items.map((e) => e.action)).toEqual(['plan_changed']);
    expect((await list({ category: 'lifecycle' })).body.items).toHaveLength(2);
    expect((await list({ actorKind: 'system' })).body.items.map((e) => e.action)).toEqual(['trial_ended']);
    const byOther = (await list({ actorId: String(otherAdmin.account._id) })).body.items.map((e) => e.action);
    expect(byOther.sort()).toEqual(['feature_flag_changed', 'platform_settings_changed']);
    expect((await list({ tenantId: String(tenant._id) })).body.items).toHaveLength(6);
    expect((await list({ targetType: 'tenant_feature' })).body.items.map((e) => e.action)).toEqual(['feature_flag_changed']);
  });

  test('from is inclusive, before is exclusive', async () => {
    const res = await list({ from: at(1).toISOString(), before: at(4).toISOString() }).expect(200);
    expect(res.body.items.map((e) => e.action)).toEqual(['trial_ended', 'feature_flag_changed', 'plan_changed']);
  });

  test('filters apply before paging', async () => {
    const page1 = await list({ tenantId: String(tenant._id), limit: 4 }).expect(200);
    expect(page1.body.items).toHaveLength(4);
    const page2 = await list({ tenantId: String(tenant._id), limit: 4, cursor: page1.body.nextCursor }).expect(200);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();
  });

  test('search is case-insensitive over id, actor, target and tenant', async () => {
    expect((await list({ search: 'leader admin' })).body.items).toHaveLength(4);
    expect((await list({ search: 'INVENTORY' })).body.items.map((e) => e.action)).toEqual(['feature_flag_changed']);
    expect((await list({ search: 'الهلال' })).body.items).toHaveLength(6);
    expect((await list({ search: 'demo.duration' })).body.items.map((e) => e.action)).toEqual(['platform_settings_changed']);
    const id = String(events[1]._id);
    expect((await list({ search: id })).body.items.map((e) => e.id)).toEqual([id]);
    // Regex metacharacters are literal.
    expect((await list({ search: '.*(' }).expect(200)).body.items).toEqual([]);
  });

  test('validation: bad cursor, from ≥ before, bad instant, limit out of range', async () => {
    const bad = await list({ cursor: 'not-a-cursor' }).expect(422);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.fields).toHaveProperty('cursor');

    const wrongShape = await list({ cursor: cursorUtil.encode({ s: 'rpt_x', o: 2 }) }).expect(422);
    expect(wrongShape.body.error.code).toBe('validation');

    const range = await list({ from: at(4).toISOString(), before: at(4).toISOString() }).expect(422);
    expect(range.body.error.code).toBe('validation');
    expect(range.body.error.fields).toHaveProperty('before');

    expect((await list({ from: 'yesterday' }).expect(422)).body.error.fields).toHaveProperty('from');
    expect((await list({ limit: 101 }).expect(422)).body.error.code).toBe('validation');
    expect((await list({ limit: 0 }).expect(422)).body.error.code).toBe('validation');
  });
});

describe('GET /platform/audit/:eventId', () => {
  test('returns one platform event', async () => {
    const id = String(events[2]._id);
    const res = await f.api().get(`/api/v1/platform/audit/${id}`).set(f.auth(platform.token)).expect(200);
    expect(res.body).toMatchObject({ id, action: 'feature_flag_changed', category: 'entitlement' });
  });

  test('tenant-stream and unknown ids are 404 not_found', async () => {
    const hidden = await f.api().get(`/api/v1/platform/audit/${tenantEvent._id}`).set(f.auth(platform.token)).expect(404);
    expect(hidden.body.error.code).toBe('not_found');
    await f.api().get('/api/v1/platform/audit/audit_nope').set(f.auth(platform.token)).expect(404);
  });
});
