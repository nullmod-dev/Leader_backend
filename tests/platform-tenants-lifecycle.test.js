/**
 * /platform/tenants/:tenantId/lifecycle/** — the full Point 9 state machine,
 * break-glass side effect, idempotency, and the final deletion cascade.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const f = require('./helpers/factory');
const storageService = require('../services/storageService');

const BASE = '/api/v1/platform/tenants';
const DAY = 86400000;

let sa;

beforeAll(async () => {
  await f.ensurePlans();
  sa = await f.superAdmin();
});

const cmd = (tenantId, path, payload, key) =>
  f
    .api()
    .post(`${BASE}/${tenantId}/lifecycle/${path}`)
    .set(f.auth(sa.token))
    .set(key ? { 'Idempotency-Key': key } : f.idem())
    .send(payload);

const history = async (tenantId) => (await f.models.TenantStatusEvent.find({ tenantId }).sort({ occurredAt: -1, _id: -1 })).map((e) => e.type);

describe('suspend / reactivate', () => {
  test('active → suspended keeps subscription/features/Team Code and blocks tenant users', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const grant = await f.models.BreakGlassGrant.create({
      sessionId: String(sa.session._id),
      tenant: { tenantId: String(tenant._id), displayName: tenant.displayName },
      reason: 'دعم فني',
      initiator: { accountId: String(sa.account._id), displayName: sa.account.name },
      expiresAt: new Date(Date.now() + 3600000),
    });

    const res = await cmd(tenant._id, 'suspend', { reason: '  مراجعة   إدارية ', expectedVersion: 1 }).expect(200);
    expect(res.body).toMatchObject({ tenantId: String(tenant._id), displayNameSnapshot: tenant.displayName, changed: true });
    expect(res.body.lifecycle).toMatchObject({ status: 'suspended', version: 2, suspension: { reason: 'مراجعة إدارية' } });
    expect(res.body.lifecycle.suspension.suspendedAt).toMatch(/Z$/);
    expect(res.body.lifecycle.deletion).toBeUndefined();

    const fresh = await f.models.SaasTenant.findById(tenant._id);
    expect(fresh.subscription.version).toBe(1);
    expect(fresh.teamCode).toBe(tenant.teamCode);
    expect(fresh.features.every((x) => x.version === 1)).toBe(true);

    const ended = await f.models.BreakGlassGrant.findById(grant._id);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'tenant_unavailable', revision: 2 });

    const evt = await f.models.TenantStatusEvent.findOne({ tenantId: String(tenant._id), type: 'tenant_suspended' });
    expect(evt.note).toBe('مراجعة إدارية');
    const audit = await f.models.AuditEvent.findOne({ action: 'tenant_suspended', 'tenant.id': String(tenant._id) });
    expect(audit.category).toBe('lifecycle');
    expect(audit.changes[0]).toMatchObject({ field: 'lifecycle_status', before: { value: 'active' }, after: { value: 'suspended' } });

    const blocked = await f.api().get('/api/v1/detachments').set(f.auth(main.token));
    if (blocked.status !== 404) {
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toMatchObject({ code: 'tenant_unavailable', tenantStatus: 'suspended' });
    }

    const again = await cmd(tenant._id, 'suspend', { reason: 'مرة ثانية', expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_tenant_transition');

    const back = await cmd(tenant._id, 'reactivate', { expectedVersion: 2 }).expect(200);
    expect(back.body.lifecycle).toEqual({ status: 'active', version: 3 });
    const reread = await f.api().get(`${BASE}/${tenant._id}`).set(f.auth(sa.token)).expect(200);
    expect(reread.body.lifecycle).toEqual({ status: 'active', version: 3 });
    expect(await history(String(tenant._id))).toEqual(['tenant_reactivated', 'tenant_suspended']);

    const noop = await cmd(tenant._id, 'reactivate', { expectedVersion: 3 });
    expect(noop.status).toBe(409);
    expect(noop.body.error.code).toBe('invalid_tenant_transition');
  });

  test('reason is required, collapsed, ≤ 280 → else 422 invalid_lifecycle_reason', async () => {
    const tenant = await f.createTenant();
    for (const reason of [undefined, '', '    ', 'x'.repeat(281), 42]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await cmd(tenant._id, 'suspend', { reason, expectedVersion: 1 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_lifecycle_reason');
    }
    expect((await f.models.SaasTenant.findById(tenant._id)).lifecycle.version).toBe(1);
  });

  test('stale expectedVersion → 409 stale_tenant; missing → 422 validation; unknown → 404 tenant_not_found', async () => {
    const tenant = await f.createTenant();
    const stale = await cmd(tenant._id, 'suspend', { reason: 'سبب', expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_tenant', currentVersion: 1 });
    const missing = await cmd(tenant._id, 'suspend', { reason: 'سبب' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.expectedVersion).toBeDefined();
    const unknown = await cmd('saas_nope', 'suspend', { reason: 'سبب', expectedVersion: 1 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('tenant_not_found');
  });

  test('idempotent replay: same key same body → original result, no second event; other body → conflict', async () => {
    const tenant = await f.createTenant();
    const key = `life-${f.uniq()}`;
    const first = await cmd(tenant._id, 'suspend', { reason: 'مراجعة', expectedVersion: 1 }, key).expect(200);
    const replay = await cmd(tenant._id, 'suspend', { reason: 'مراجعة', expectedVersion: 1 }, key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: String(tenant._id), type: 'tenant_suspended' })).toBe(1);
    const conflict = await cmd(tenant._id, 'suspend', { reason: 'سبب آخر', expectedVersion: 1 }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });
});

describe('deletion: begin / cancel / finalize guards', () => {
  test('begin from active schedules by the deletion window; cancel restores active', async () => {
    const tenant = await f.createTenant();
    const res = await cmd(tenant._id, 'deletion/begin', { reason: 'طلب إغلاق موثّق', expectedVersion: 1 }).expect(200);
    const { lifecycle } = res.body;
    expect(lifecycle).toMatchObject({ status: 'deletion_pending', version: 2, deletion: { previousStatus: 'active', reason: 'طلب إغلاق موثّق' } });
    expect(lifecycle.suspension).toBeUndefined();
    expect(Math.abs(new Date(lifecycle.deletion.scheduledFor) - new Date(lifecycle.deletion.requestedAt) - 30 * DAY)).toBeLessThan(1000);

    const early = await cmd(tenant._id, 'deletion/finalize', { expectedVersion: 2 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('deletion_not_effective');

    const cancel = await cmd(tenant._id, 'deletion/cancel', { expectedVersion: 2 }).expect(200);
    expect(cancel.body.lifecycle).toEqual({ status: 'active', version: 3 });
    expect(await history(String(tenant._id))).toEqual(['deletion_cancelled', 'deletion_requested']);
  });

  test('begin from suspended keeps suspension; cancel restores suspended exactly', async () => {
    const tenant = await f.createTenant();
    await cmd(tenant._id, 'suspend', { reason: 'مراجعة إدارية', expectedVersion: 1 }).expect(200);
    const begin = await cmd(tenant._id, 'deletion/begin', { reason: 'إغلاق', expectedVersion: 2 }).expect(200);
    expect(begin.body.lifecycle).toMatchObject({ status: 'deletion_pending', suspension: { reason: 'مراجعة إدارية' }, deletion: { previousStatus: 'suspended' } });
    const cancel = await cmd(tenant._id, 'deletion/cancel', { expectedVersion: 3 }).expect(200);
    expect(cancel.body.lifecycle).toMatchObject({ status: 'suspended', version: 4, suspension: { reason: 'مراجعة إدارية' } });
    expect(cancel.body.lifecycle.deletion).toBeUndefined();
    const reread = await f.api().get(`${BASE}/${tenant._id}`).set(f.auth(sa.token)).expect(200);
    expect(reread.body.lifecycle).toEqual(cancel.body.lifecycle);
  });

  test('illegal transitions → 409 invalid_tenant_transition', async () => {
    const tenant = await f.createTenant();
    for (const path of ['reactivate', 'deletion/cancel', 'deletion/finalize']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await cmd(tenant._id, path, { expectedVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_tenant_transition');
    }
    await cmd(tenant._id, 'deletion/begin', { reason: 'إغلاق', expectedVersion: 1 }).expect(200);
    const twice = await cmd(tenant._id, 'deletion/begin', { reason: 'إغلاق', expectedVersion: 2 });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('invalid_tenant_transition');
    const suspend = await cmd(tenant._id, 'suspend', { reason: 'x', expectedVersion: 2 });
    expect(suspend.body.error.code).toBe('invalid_tenant_transition');
  });

  describe('with a zero-day deletion window', () => {
    beforeAll(() => f.setSettings({ deletionWindowDays: 0 }));
    afterAll(() => f.setSettings({ deletionWindowDays: 30 }));

    test('cancel after the window → 409 deletion_window_expired', async () => {
      const tenant = await f.createTenant();
      await cmd(tenant._id, 'deletion/begin', { reason: 'إغلاق', expectedVersion: 1 }).expect(200);
      const res = await cmd(tenant._id, 'deletion/cancel', { expectedVersion: 2 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('deletion_window_expired');
    });

    test('finalize: cascade, tombstone, retired Team Code, replay-safe', async () => {
      // A tenant registered through the API (pending seat) with operational data, a Simple Admin and a stored file.
      const created = await f
        .api()
        .post(BASE)
        .set(f.auth(sa.token))
        .set(f.idem())
        .send({ displayName: 'فرق الأمل الطبية', mainAdminName: 'ريم القحطاني', mainAdminEmail: `${f.uniq('reem')}@amal.org` })
        .expect(201);
      const tenantId = created.body.id;
      const tenant = await f.models.SaasTenant.findById(tenantId);
      const seatAccountId = tenant.seat.currentAccountId;
      const simple = await f.simpleAdmin(tenant);
      const g = await f.group(tenant);
      const det = await f.detachment(tenant, g);
      await f.member(tenant, det);
      await f.inventoryItem(tenant, det);
      await f.shift(tenant, det);
      await f.workshop(tenant);
      const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2a7' } }).png().toBuffer();
      const file = await storageService.saveImage(png, 'member', { ownerType: 'member', ownerId: 'm_fin', tenantId });
      await f.api().get(file.path).expect(200);

      await cmd(tenantId, 'deletion/begin', { reason: 'طلب إغلاق موثّق', expectedVersion: 1 }).expect(200);
      const key = `final-${f.uniq()}`;
      const res = await cmd(tenantId, 'deletion/finalize', { expectedVersion: 2 }, key).expect(200);
      expect(res.body).toMatchObject({ tenantId, displayNameSnapshot: 'فرق الأمل الطبية', changed: true });
      expect(res.body.lifecycle).toMatchObject({ status: 'deleted', version: 3, deletion: { previousStatus: 'active' } });
      expect(res.body.lifecycle.deletion.deletedAt).toMatch(/Z$/);
      expect(res.body.tombstone).toEqual({
        tenantId,
        displayNameSnapshot: 'فرق الأمل الطبية',
        status: 'deleted',
        deletedAt: res.body.lifecycle.deletion.deletedAt,
        lifecycleVersion: 3,
        historyReference: `tenant-lifecycle:${tenantId}`,
      });

      // Everything tenant-owned is gone.
      const m = f.models;
      expect(await m.SaasTenant.exists({ _id: tenantId })).toBeNull();
      for (const Model of [m.DetachmentGroup, m.Detachment, m.TeamMember, m.InventoryItem, m.Shift, m.Workshop, m.ChangeLog, m.Authorization, m.StoredFile]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await Model.countDocuments({ tenantId })).toBe(0);
      }
      expect(await m.Account.exists({ _id: seatAccountId })).toBeNull();
      expect(await m.Account.exists({ _id: simple.account._id })).toBeNull();
      expect(await m.Account.exists({ _id: sa.account._id })).not.toBeNull();
      expect((await m.Session.findById(simple.session._id)).revokedAt).toBeInstanceOf(Date);
      expect(fs.existsSync(path.join(storageService.PUBLIC_DIR, ...file.path.split('/').filter(Boolean)))).toBe(false);
      expect((await f.api().get(file.path)).status).not.toBe(200);
      const denied = await f.api().get('/api/v1/auth/me').set(f.auth(simple.token));
      expect([401, 404]).toContain(denied.status);

      // The tombstone is what remains readable.
      const read = await f.api().get(`${BASE}/${tenantId}`).set(f.auth(sa.token)).expect(200);
      expect(read.body).toEqual(res.body.tombstone);
      const hist = await f.api().get(`${BASE}/${tenantId}/status-history`).set(f.auth(sa.token)).expect(200);
      expect(hist.body.map((e) => e.type)).toEqual(['tenant_deleted', 'deletion_requested', 'trial_started', 'tenant_created']);
      const listed = await f.api().get(BASE).query({ search: 'فرق الأمل الطبية' }).set(f.auth(sa.token)).expect(200);
      expect(listed.body.items.map((t) => t.id)).not.toContain(tenantId);
      const audit = await m.AuditEvent.findOne({ action: 'deletion_finalized', 'tenant.id': tenantId });
      expect(audit.tenant).toMatchObject({ displayName: 'فرق الأمل الطبية', isDeleted: true });

      // Replay with the same key → the original result; a new key → tenant_already_deleted.
      const replay = await cmd(tenantId, 'deletion/finalize', { expectedVersion: 2 }, key).expect(200);
      expect(replay.body).toEqual(res.body);
      const retry = await cmd(tenantId, 'deletion/finalize', { expectedVersion: 3 });
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('tenant_already_deleted');

      // Other families on a tombstone.
      const seat = await f.api().get(`${BASE}/${tenantId}/main-admin`).set(f.auth(sa.token));
      expect(seat.status).toBe(409);
      expect(seat.body.error.code).toBe('tenant_already_deleted');
      const sub = await f.api().get(`${BASE}/${tenantId}/subscription`).set(f.auth(sa.token));
      expect(sub.status).toBe(404);
      expect(sub.body.error.code).toBe('not_found');
      const feats = await f.api().get(`${BASE}/${tenantId}/features`).set(f.auth(sa.token));
      expect(feats.status).toBe(404);
      expect(feats.body.error.code).toBe('tenant_not_found');

      // The Team Code is retired forever.
      const reuse = await f
        .api()
        .post(BASE)
        .set(f.auth(sa.token))
        .set(f.idem())
        .send({ displayName: 'فريق جديد', mainAdminName: 'سالم', mainAdminEmail: `${f.uniq('salem')}@x.org`, teamCode: created.body.teamCode });
      expect(reuse.status).toBe(409);
      expect(reuse.body.error.code).toBe('tenant_code_conflict');
    });
  });
});
