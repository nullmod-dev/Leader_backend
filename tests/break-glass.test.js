/**
 * Break-glass emergency access (Point 12): grant lifecycle, refusal codes,
 * idempotency, settle-on-read, the settlement job and the grant-scoped
 * read-only viewer.
 */
const f = require('./helpers/factory');
const tokenService = require('../services/tokenService');
const settleJob = require('../jobs/definitions/03-settle-break-glass');

const BASE = '/api/v1/platform/break-glass';
const REASON = 'تعذّر على قائد الفريق الوصول إلى سجلات المناوبات';

let platform; // super admin session
let tenant;
let main;
let det;
let det2;
let memberDoc;

const activateBody = (t = tenant, overrides = {}) => ({
  tenantId: String(t._id),
  expectedTenantVersion: t.lifecycle.version,
  scopes: ['tenant_operational_read'],
  reason: REASON,
  ...overrides,
});

const activate = (session, body = activateBody(), headers = f.idem()) =>
  f.api().post(`${BASE}/grants`).set(f.auth(session.token)).set(headers).send(body);

const newPlatformSession = async () => f.login(platform.account);

beforeAll(async () => {
  platform = await f.superAdmin();
  ({ tenant, main } = await f.tenantWithMainAdmin());
  const grp = await f.group(tenant);
  det = await f.detachment(tenant, grp);
  det2 = await f.detachment(tenant, grp);
  memberDoc = await f.member(tenant, det, { name: 'سامر الأحمد', phone: '+963912345678' });
  await f.member(tenant, det2, { name: 'ليلى حسن', phone: '+963933222111' });
  await f.shift(tenant, det, { attendees: [{ memberId: String(memberDoc._id), attendance: 'checkedIn' }] });
  await f.inventoryItem(tenant, det);
  await f.workshop(tenant, { organizingTeam: [{ memberId: String(memberDoc._id) }] });
});

describe('GET /current', () => {
  test('no grant → { grant: null, readAt }', async () => {
    const s = await newPlatformSession();
    const res = await f.api().get(`${BASE}/current`).set(f.auth(s.token)).expect(200);
    expect(res.body.grant).toBeNull();
    expect(typeof res.body.readAt).toBe('string');
  });

  test('tenant roles and demo are refused (not_permitted)', async () => {
    const res = await f.api().get(`${BASE}/current`).set(f.auth(main.token)).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });

  test('no bearer → 401 authentication_expired', async () => {
    const res = await f.api().get(`${BASE}/current`).expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });
});

describe('POST /grants — refusals in contract order', () => {
  let s;
  beforeAll(async () => {
    s = await newPlatformSession();
  });

  test('Idempotency-Key is required', async () => {
    const res = await f.api().post(`${BASE}/grants`).set(f.auth(s.token)).send(activateBody()).expect(422);
    expect(res.body.error.fields['Idempotency-Key']).toBeDefined();
  });

  test('missing tenantId / version → validation', async () => {
    const res = await activate(s, { scopes: ['tenant_operational_read'], reason: REASON }).expect(422);
    expect(res.body.error.code).toBe('validation');
    expect(res.body.error.fields).toHaveProperty('tenantId');
    expect(res.body.error.fields).toHaveProperty('expectedTenantVersion');
  });

  test.each([['   '], [''], ['x'.repeat(281)], [42]])('reason %p → invalid_break_glass_reason', async (reason) => {
    const res = await activate(s, activateBody(tenant, { reason })).expect(422);
    expect(res.body.error.code).toBe('invalid_break_glass_reason');
  });

  test('reason is checked before scopes', async () => {
    const res = await activate(s, activateBody(tenant, { reason: ' ', scopes: [] })).expect(422);
    expect(res.body.error.code).toBe('invalid_break_glass_reason');
  });

  test.each([[[]], [['tenant_write']], [['tenant_operational_read', 'x']], ['tenant_operational_read']])(
    'scopes %p → invalid_break_glass_scope',
    async (scopes) => {
      const res = await activate(s, activateBody(tenant, { scopes })).expect(422);
      expect(res.body.error.code).toBe('invalid_break_glass_scope');
    },
  );

  test('stale authentication → 403 recent_authentication_required', async () => {
    const old = await newPlatformSession();
    await f.models.Session.updateOne({ _id: old.session._id }, { $set: { authenticatedAt: new Date(Date.now() - 2 * 3600000) } });
    const res = await activate(old).expect(403);
    expect(res.body.error.code).toBe('recent_authentication_required');
  });

  test('tombstoned tenant → 409 tenant_already_deleted', async () => {
    await f.models.TenantTombstone.create({
      _id: 'saas_gone',
      displayNameSnapshot: 'فريق محذوف',
      deletedAt: new Date(),
      lifecycleVersion: 4,
      historyReference: 'hist_1',
    });
    const res = await activate(s, activateBody(tenant, { tenantId: 'saas_gone', expectedTenantVersion: 4 })).expect(409);
    expect(res.body.error.code).toBe('tenant_already_deleted');
  });

  test('unknown tenant → 404 tenant_not_found', async () => {
    const res = await activate(s, activateBody(tenant, { tenantId: 'saas_nope' })).expect(404);
    expect(res.body.error.code).toBe('tenant_not_found');
  });

  test('suspended tenant → 409 tenant_not_eligible', async () => {
    const suspended = await f.createTenant({ lifecycle: { status: 'suspended', version: 2 } });
    const res = await activate(s, activateBody(suspended)).expect(409);
    expect(res.body.error).toMatchObject({ code: 'tenant_not_eligible', tenantStatus: 'suspended' });
  });

  test('lifecycle version mismatch → 409 stale_tenant', async () => {
    const res = await activate(s, activateBody(tenant, { expectedTenantVersion: tenant.lifecycle.version + 5 })).expect(409);
    expect(res.body.error).toMatchObject({ code: 'stale_tenant', currentVersion: tenant.lifecycle.version });
  });
});

describe('grant lifecycle', () => {
  let s;
  let grant;

  beforeAll(async () => {
    s = await newPlatformSession();
  });

  test('activate → 201 active grant (+ audit, replay, already_active)', async () => {
    const key = f.idem();
    const res = await activate(s, activateBody(tenant, { reason: `  ${REASON}   ` }), key).expect(201);
    grant = res.body;
    expect(grant).toMatchObject({
      revision: 1,
      tenant: { tenantId: String(tenant._id), displayName: tenant.displayName },
      scopes: ['tenant_operational_read'],
      reason: REASON,
      initiator: { accountId: String(platform.account._id), displayName: platform.account.name },
      status: 'active',
    });
    expect(grant.id).toMatch(/^bg_/);
    expect(grant).not.toHaveProperty('sessionId');
    expect(grant).not.toHaveProperty('endedAt');
    const minutes = (new Date(grant.expiresAt) - new Date(grant.issuedAt)) / 60000;
    expect(minutes).toBe(60);

    const audit = await f.models.AuditEvent.find({ action: 'break_glass_activated', 'target.id': grant.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ category: 'emergency_access', actor: { kind: 'platform_administrator' }, target: { type: 'break_glass_grant' } });
    expect(audit[0].tenant.id).toBe(String(tenant._id));

    // Same key + same body → the original answer, no new effect.
    const replay = await activate(s, activateBody(tenant, { reason: `  ${REASON}   ` }), key).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(grant.id);
    expect(await f.models.BreakGlassGrant.countDocuments({ sessionId: String(s.session._id) })).toBe(1);

    // A new attempt while live → already_active.
    const again = await activate(s).expect(409);
    expect(again.body.error.code).toBe('break_glass_already_active');
  });

  test('current → the live grant', async () => {
    const res = await f.api().get(`${BASE}/current`).set(f.auth(s.token)).expect(200);
    expect(res.body.grant.id).toBe(grant.id);
    expect(res.body.grant.status).toBe('active');
  });

  test('another session of the same account does not see it (bound to the session)', async () => {
    const other = await newPlatformSession();
    const res = await f.api().get(`${BASE}/current`).set(f.auth(other.token)).expect(200);
    expect(res.body.grant).toBeNull();
    const end = await f.api().post(`${BASE}/grants/${grant.id}/end`).set(f.auth(other.token)).set(f.idem()).send({ expectedRevision: 1 }).expect(404);
    expect(end.body.error.code).toBe('break_glass_not_found');
  });

  describe('viewer (read-only, grant-scoped)', () => {
    const view = (path, query = {}) => f.api().get(`${BASE}/view/${path}`).query(query).set(f.auth(s.token));

    test('detachment-groups and detachments with roll-ups', async () => {
      const groups = await view('detachment-groups').expect(200);
      expect(groups.body).toMatchObject({ grantId: grant.id, tenant: { tenantId: String(tenant._id), displayName: tenant.displayName } });
      expect(groups.body.items).toHaveLength(1);
      expect(groups.body.items[0]).toMatchObject({ detachmentCount: 2, memberCount: 2 });
      const dets = await view('detachments').expect(200);
      expect(dets.body.items.map((d) => d.id).sort()).toEqual([String(det._id), String(det2._id)].sort());
    });

    test('members never carry phone numbers', async () => {
      const all = await view('members').expect(200);
      expect(all.body.items).toHaveLength(2);
      all.body.items.forEach((m) => {
        expect(m).not.toHaveProperty('phoneMasked');
        expect(m).not.toHaveProperty('phone');
      });
      const one = await view('members', { detachmentId: String(det._id) }).expect(200);
      expect(one.body.items.map((m) => m.id)).toEqual([String(memberDoc._id)]);
      const unknown = await view('members', { detachmentId: 'd_nope' }).expect(404);
      expect(unknown.body.error.code).toBe('not_found');
    });

    test('shifts: default week, explicit range, range limit', async () => {
      const res = await view('shifts').expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].attendees[0]).not.toHaveProperty('phoneMasked');
      const today = res.body.items[0].date;
      const ranged = await view('shifts', { from: today, to: today, detachmentId: String(det2._id) }).expect(200);
      expect(ranged.body.items).toHaveLength(0);
      const tooWide = await view('shifts', { from: '2026-01-01', to: '2026-02-15' }).expect(422);
      expect(tooWide.body.error.fields).toHaveProperty('to');
      const bad = await view('shifts', { from: '2026-13-01', to: '2026-01-02' }).expect(422);
      expect(bad.body.error.fields).toHaveProperty('from');
    });

    test('inventory-items and workshops (feature flags honoured)', async () => {
      const items = await view('inventory-items').expect(200);
      expect(items.body.items).toHaveLength(1);
      const ws = await view('workshops').expect(200);
      expect(ws.body.items).toHaveLength(1);
      expect(ws.body.items[0].organizingTeam[0]).not.toHaveProperty('phoneMasked');

      await f.models.SaasTenant.updateOne({ _id: tenant._id, 'features.key': 'inventory' }, { $set: { 'features.$.enabled': false } });
      const off = await view('inventory-items').expect(403);
      expect(off.body.error).toMatchObject({ code: 'feature_disabled', feature: 'inventory' });
      await f.models.SaasTenant.updateOne({ _id: tenant._id, 'features.key': 'inventory' }, { $set: { 'features.$.enabled': true } });
    });

    test('there is no write path and no unknown resource', async () => {
      await f.api().post(`${BASE}/view/members`).set(f.auth(s.token)).send({}).expect(404);
      await f.api().get(`${BASE}/view/accounts`).set(f.auth(s.token)).expect(404);
    });

    test('a session without a grant is refused', async () => {
      const other = await newPlatformSession();
      const res = await f.api().get(`${BASE}/view/detachments`).set(f.auth(other.token)).expect(403);
      expect(res.body.error.code).toBe('not_permitted');
    });
  });

  test('list: every grant, newest first, filters and cursor', async () => {
    const res = await f.api().get(`${BASE}/grants`).set(f.auth(s.token)).expect(200);
    expect(res.body.items[0].id).toBe(grant.id);
    const active = await f.api().get(`${BASE}/grants?status=active`).set(f.auth(s.token)).expect(200);
    expect(active.body.items.every((g) => g.status === 'active')).toBe(true);
    const bad = await f.api().get(`${BASE}/grants?status=weird`).set(f.auth(s.token)).expect(422);
    expect(bad.body.error.code).toBe('validation');
  });

  test('end: stale revision, success, then not_active; viewer closes', async () => {
    const staleRes = await f.api().post(`${BASE}/grants/${grant.id}/end`).set(f.auth(s.token)).set(f.idem()).send({ expectedRevision: 7 }).expect(409);
    expect(staleRes.body.error).toMatchObject({ code: 'stale_break_glass', currentRevision: 1 });

    const missing = await f.api().post(`${BASE}/grants/${grant.id}/end`).set(f.auth(s.token)).set(f.idem()).send({}).expect(422);
    expect(missing.body.error.fields).toHaveProperty('expectedRevision');

    const res = await f.api().post(`${BASE}/grants/${grant.id}/end`).set(f.auth(s.token)).set(f.idem()).send({ expectedRevision: 1 }).expect(200);
    expect(res.body).toMatchObject({ id: grant.id, status: 'ended', endReason: 'ended_by_initiator', revision: 2 });
    expect(typeof res.body.endedAt).toBe('string');
    expect(await f.models.AuditEvent.countDocuments({ action: 'break_glass_ended', 'target.id': grant.id })).toBe(1);

    const again = await f.api().post(`${BASE}/grants/${grant.id}/end`).set(f.auth(s.token)).set(f.idem()).send({ expectedRevision: 2 }).expect(409);
    expect(again.body.error.code).toBe('break_glass_not_active');

    const viewer = await f.api().get(`${BASE}/view/detachments`).set(f.auth(s.token)).expect(403);
    expect(viewer.body.error.code).toBe('not_permitted');

    const cur = await f.api().get(`${BASE}/current`).set(f.auth(s.token)).expect(200);
    expect(cur.body.grant).toMatchObject({ id: grant.id, status: 'ended' });

    // Renewal is a new grant with a new reason.
    const renewed = await activate(s).expect(201);
    expect(renewed.body.id).not.toBe(grant.id);
    await f.api().post(`${BASE}/grants/${renewed.body.id}/end`).set(f.auth(s.token)).set(f.idem()).send({ expectedRevision: 1 }).expect(200);
  });

  test('cursor pages through the list', async () => {
    const first = await f.api().get(`${BASE}/grants?limit=1`).set(f.auth(s.token)).expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await f.api().get(`${BASE}/grants`).query({ limit: 1, cursor: first.body.nextCursor }).set(f.auth(s.token)).expect(200);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    await f.api().get(`${BASE}/grants?cursor=garbage`).set(f.auth(s.token)).expect(422);
  });
});

describe('revoke (any super admin)', () => {
  test('revoked_by_platform + audit break_glass_revoked', async () => {
    const holder = await newPlatformSession();
    const { body: g } = await activate(holder).expect(201);
    const otherAdmin = await f.superAdmin({ name: 'مشرف ثانٍ' });
    const stale = await f.api().post(`${BASE}/grants/${g.id}/revoke`).set(f.auth(otherAdmin.token)).set(f.idem()).send({ expectedRevision: 3 }).expect(409);
    expect(stale.body.error.code).toBe('stale_break_glass');
    const res = await f.api().post(`${BASE}/grants/${g.id}/revoke`).set(f.auth(otherAdmin.token)).set(f.idem()).send({ expectedRevision: 1 }).expect(200);
    expect(res.body).toMatchObject({ status: 'ended', endReason: 'revoked_by_platform', revision: 2 });
    const audit = await f.models.AuditEvent.findOne({ action: 'break_glass_revoked', 'target.id': g.id });
    expect(audit.actor).toMatchObject({ kind: 'platform_administrator', id: String(otherAdmin.account._id) });
    const unknown = await f.api().post(`${BASE}/grants/bg_nope/revoke`).set(f.auth(otherAdmin.token)).set(f.idem()).send({ expectedRevision: 1 }).expect(404);
    expect(unknown.body.error.code).toBe('break_glass_not_found');
    await f.api().post(`${BASE}/grants/${g.id}/revoke`).set(f.auth(main.token)).set(f.idem()).send({ expectedRevision: 2 }).expect(403);
  });
});

describe('expiry and settlement', () => {
  test('settle on read: an active grant past expiresAt reads as expired', async () => {
    const s = await newPlatformSession();
    const { body: g } = await activate(s).expect(201);
    await f.models.BreakGlassGrant.updateOne({ _id: g.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await f.api().get(`${BASE}/current`).set(f.auth(s.token)).expect(200);
    expect(res.body.grant).toMatchObject({ id: g.id, status: 'expired', revision: 2 });
    expect(res.body.grant).not.toHaveProperty('endReason');
    const audit = await f.models.AuditEvent.find({ action: 'break_glass_expired', 'target.id': g.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].actor.kind).toBe('system');
    // Terminal: ending an expired grant is refused.
    const end = await f.api().post(`${BASE}/grants/${g.id}/end`).set(f.auth(s.token)).set(f.idem()).send({ expectedRevision: 2 }).expect(409);
    expect(end.body.error.code).toBe('break_glass_not_active');
    // An expired grant never blocks a new one.
    await activate(s).expect(201);
  });

  test('job: expiry, ended session, unavailable tenant', async () => {
    // expiry
    const s1 = await newPlatformSession();
    const { body: g1 } = await activate(s1).expect(201);
    await f.models.BreakGlassGrant.updateOne({ _id: g1.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    // session ended
    const s2 = await newPlatformSession();
    const { body: g2 } = await activate(s2).expect(201);
    await tokenService.revokeSession(String(s2.session._id), 'signed_out');
    // tenant leaves active
    const other = await f.createTenant();
    const s3 = await newPlatformSession();
    const { body: g3 } = await activate(s3, activateBody(other)).expect(201);
    await f.models.SaasTenant.updateOne({ _id: other._id }, { $set: { 'lifecycle.status': 'suspended' }, $inc: { 'lifecycle.version': 1 } });

    const affected = await settleJob.run();
    expect(affected).toBeGreaterThanOrEqual(3);
    const [a, b, c] = await Promise.all([g1, g2, g3].map((g) => f.models.BreakGlassGrant.findById(g.id)));
    expect(a.status).toBe('expired');
    expect(b).toMatchObject({ status: 'ended', endReason: 'session_ended', revision: 2 });
    expect(c).toMatchObject({ status: 'ended', endReason: 'tenant_unavailable' });
    expect(await f.models.AuditEvent.countDocuments({ action: 'break_glass_revoked', 'target.id': { $in: [g2.id, g3.id] } })).toBe(2);

    // Idempotent: a second run moves nothing already settled.
    const settledIds = [g1.id, g2.id, g3.id];
    await settleJob.run();
    expect(await f.models.AuditEvent.countDocuments({ 'target.id': { $in: settledIds }, action: { $ne: 'break_glass_activated' } })).toBe(3);
  });

  test('viewer: target leaves active → grant ends tenant_unavailable and the read is refused', async () => {
    const t = await f.createTenant();
    await f.detachment(t);
    const s = await newPlatformSession();
    const { body: g } = await activate(s, activateBody(t)).expect(201);
    await f.api().get(`${BASE}/view/detachments`).set(f.auth(s.token)).expect(200);
    await f.models.SaasTenant.updateOne({ _id: t._id }, { $set: { 'lifecycle.status': 'deletion_pending' } });
    const res = await f.api().get(`${BASE}/view/detachments`).set(f.auth(s.token)).expect(403);
    expect(res.body.error).toMatchObject({ code: 'tenant_unavailable', tenantStatus: 'deletion_pending' });
    const after = await f.models.BreakGlassGrant.findById(g.id);
    expect(after).toMatchObject({ status: 'ended', endReason: 'tenant_unavailable' });
    const again = await f.api().get(`${BASE}/view/detachments`).set(f.auth(s.token)).expect(403);
    expect(again.body.error.code).toBe('not_permitted');
  });
});
