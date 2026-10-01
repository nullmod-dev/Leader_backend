/**
 * Customer Demo (BACKEND-HANDOFF.md §12): atomic start, resume, policy,
 * server-time expiry, termination, operator list, cleanup and the job.
 */
const f = require('./helpers/factory');
const auditService = require('../services/auditService');
const sessionView = require('../services/sessionView');
const expireJob = require('../jobs/definitions/02-expire-demo-sessions');

const START = '/api/v1/auth/customer-demo/start';
const SESSION = '/api/v1/auth/customer-demo/session';
const END = '/api/v1/auth/customer-demo/end';
const PLATFORM = '/api/v1/platform/demo';

let platform;
let main;

const start = (body = {}) => f.api().post(START).send(body);
const installId = () => `install-${f.uniq()}-${f.uniq()}`;
const getPolicy = async () => (await f.api().get(`${PLATFORM}/policy`).set(f.auth(platform.token)).expect(200)).body;
const patchPolicy = (body) => f.api().patch(`${PLATFORM}/policy`).set(f.auth(platform.token)).set(f.idem()).send(body);
const backdate = (demoSessionId) =>
  f.models.DemoSession.updateOne({ _id: demoSessionId }, { $set: { expiresAt: new Date(Date.now() - 60000) } });

beforeAll(async () => {
  platform = await f.superAdmin();
  ({ main } = await f.tenantWithMainAdmin());
});

describe('POST /auth/customer-demo/start', () => {
  test('public, no body → 201 credential pair + active demoSession; no tenant, no Team Code', async () => {
    const tenantsBefore = await f.models.SaasTenant.countDocuments();
    const res = await start().expect(201);
    const { accessToken, refreshToken, demoSession } = res.body;
    expect(accessToken).toEqual(expect.any(String));
    expect(refreshToken).toEqual(expect.any(String));
    expect(demoSession).toMatchObject({ status: 'active', policyRevision: 1, displayName: 'زائر تجريبي' });
    expect(demoSession.demoSessionId).toMatch(/^demo_/);
    expect(demoSession.demoWorkspaceId).toMatch(/^dws_/);
    expect(demoSession).not.toHaveProperty('resumeKeyHash');
    const minutes = Math.round((new Date(demoSession.expiresAt) - new Date(demoSession.startedAt)) / 60000);
    expect(minutes).toBe(1440);

    const account = await f.models.Account.findById(demoSession.accountId);
    expect(account).toMatchObject({ role: 'customer_demo', name: 'زائر تجريبي', status: 'active', emailVerified: false, setupCompleted: true, linkStatus: 'unlinked', saasTenantId: null });
    expect(account.email).toBeUndefined();
    expect(account.demoSessionId).toBe(demoSession.demoSessionId);
    expect(await f.models.SaasTenant.countDocuments()).toBe(tenantsBefore);

    const audit = await f.models.AuditEvent.find({ action: 'customer_demo_session_started', 'target.id': demoSession.demoSessionId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ category: 'customer_demo', actor: { kind: 'system' }, target: { type: 'customer_demo_session' } });

    // SessionAccess / AuthUser as GET /auth/me serves them.
    const me = await f.api().get('/api/v1/auth/me').set(f.auth(accessToken));
    if (me.status === 200) {
      expect(me.body.user).toMatchObject({ role: 'customer_demo', saasTenantId: null, capabilities: { global: [], scoped: {} } });
      expect(me.body.access).toMatchObject({ demoMode: 'active', sessionExpiresAt: demoSession.expiresAt });
    }
    const ds = await f.models.DemoSession.findById(demoSession.demoSessionId);
    expect(sessionView.serializeAuthUser(account, null)).toMatchObject({ role: 'customer_demo', saasTenantId: null });
    expect(sessionView.serializeSessionAccess(account, null, null, ds)).toMatchObject({ demoMode: 'active' });
  });

  test('installId shape → 422 validation', async () => {
    const res = await start({ installId: 'short' }).expect(422);
    expect(res.body.error.fields).toHaveProperty('installId');
  });

  test('same installId while active → RESUME: 200, same session and expiry, new tokens, no new audit', async () => {
    const id = installId();
    const first = await start({ installId: id }).expect(201);
    const second = await start({ installId: id }).expect(200);
    expect(second.body.demoSession.demoSessionId).toBe(first.body.demoSession.demoSessionId);
    expect(second.body.demoSession.expiresAt).toBe(first.body.demoSession.expiresAt);
    expect(second.body.demoSession.policyRevision).toBe(first.body.demoSession.policyRevision);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
    expect(await f.models.AuditEvent.countDocuments({ action: 'customer_demo_session_started', 'target.id': first.body.demoSession.demoSessionId })).toBe(1);
    expect(await f.models.Account.countDocuments({ _id: first.body.demoSession.accountId })).toBe(1);
    await f.api().get(SESSION).set(f.auth(second.body.accessToken)).expect(200);
  });

  test('a double tap with the same installId converges on ONE trial', async () => {
    const id = installId();
    const [a, b] = await Promise.all([start({ installId: id }), start({ installId: id })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.demoSession.demoSessionId).toBe(b.body.demoSession.demoSessionId);
    expect(await f.models.DemoSession.countDocuments({ accountId: a.body.demoSession.accountId })).toBe(1);
  });

  test('disabled policy blocks NEW starts but a running trial still resumes', async () => {
    const id = installId();
    const running = await start({ installId: id }).expect(201);
    await f.setSettings({ 'demo.enabled': false });
    try {
      const blocked = await start().expect(403);
      expect(blocked.body.error.code).toBe('demo_unavailable');
      const blockedOther = await start({ installId: installId() }).expect(403);
      expect(blockedOther.body.error.code).toBe('demo_unavailable');
      const resumed = await start({ installId: id }).expect(200);
      expect(resumed.body.demoSession.demoSessionId).toBe(running.body.demoSession.demoSessionId);
      // Disabling terminates nothing.
      expect((await f.models.DemoSession.findById(running.body.demoSession.demoSessionId)).status).toBe('active');
    } finally {
      await f.setSettings({ 'demo.enabled': true });
    }
  });

  test('after the previous trial closed, the same install starts a fresh one', async () => {
    const id = installId();
    const first = await start({ installId: id }).expect(201);
    await backdate(first.body.demoSession.demoSessionId);
    const fresh = await start({ installId: id }).expect(201);
    expect(fresh.body.demoSession.demoSessionId).not.toBe(first.body.demoSession.demoSessionId);
  });

  test('a failure leaves NO records (atomic)', async () => {
    const counts = async () =>
      Promise.all([f.models.Account.countDocuments(), f.models.DemoSession.countDocuments(), f.models.Session.countDocuments()]);
    const before = await counts();
    const spy = jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit store down'));
    try {
      const res = await start().expect(500);
      expect(res.body.error.code).toBe('server');
    } finally {
      spy.mockRestore();
    }
    expect(await counts()).toEqual(before);
  });
});

describe('the demo session itself', () => {
  test('GET /session → { demoSession, serverNow }; tenant roles refused', async () => {
    const { body } = await start().expect(201);
    const res = await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(200);
    expect(res.body.demoSession.demoSessionId).toBe(body.demoSession.demoSessionId);
    expect(typeof res.body.serverNow).toBe('string');
    const refused = await f.api().get(SESSION).set(f.auth(main.token)).expect(403);
    expect(refused.body.error.code).toBe('not_permitted');
    await f.api().get(SESSION).expect(401);
  });

  test('expiry is decided by SERVER time and persisted once (no revocation on read)', async () => {
    const { body } = await start().expect(201);
    const id = body.demoSession.demoSessionId;
    await backdate(id);
    const res = await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(200);
    expect(res.body.demoSession.status).toBe('expired');
    await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(200);
    expect((await f.models.DemoSession.findById(id)).status).toBe('expired');
    const audit = await f.models.AuditEvent.find({ action: 'customer_demo_session_expired', 'target.id': id });
    expect(audit).toHaveLength(1);
    expect(audit[0].actor.kind).toBe('system');
    // Demo-authorized reads are rejected once the window closed.
    const quote = await f.api().post('/api/v1/pricing/quote').set(f.auth(body.accessToken)).send({ billingOptionId: 'monthly' }).expect(401);
    expect(quote.body.error.code).toBe('authentication_expired');
    // Ending an expired trial is refused.
    const end = await f.api().post(END).set(f.auth(body.accessToken)).expect(409);
    expect(end.body.error.code).toBe('demo_session_not_active');
  });

  test('POST /end → terminated user_ended, sessions revoked, audit actor system', async () => {
    const { body } = await start().expect(201);
    await f.api().post('/api/v1/pricing/quote').set(f.auth(body.accessToken)).send({ billingOptionId: 'monthly' }).expect(200);
    const res = await f.api().post(END).set(f.auth(body.accessToken)).expect(200);
    expect(res.body.demoSession).toMatchObject({ status: 'terminated', terminationReason: 'user_ended' });
    expect(typeof res.body.demoSession.endedAt).toBe('string');
    const audit = await f.models.AuditEvent.findOne({ action: 'customer_demo_session_terminated', 'target.id': body.demoSession.demoSessionId });
    expect(audit.actor.kind).toBe('system');
    const after = await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(401);
    expect(after.body.error.code).toBe('authentication_expired');
  });

  test('a demo session is refused by platform and tenant endpoints', async () => {
    const { body } = await start().expect(201);
    const platformRes = await f.api().get(`${PLATFORM}/policy`).set(f.auth(body.accessToken)).expect(403);
    expect(platformRes.body.error.code).toBe('not_permitted');
    const tenantRes = await f.api().get('/api/v1/detachments').set(f.auth(body.accessToken));
    expect([403, 404]).toContain(tenantRes.status);
    if (tenantRes.status === 403) expect(tenantRes.body.error.code).toBe('tenant_context_unavailable');
    const checkout = await f.api().post('/api/v1/billing/checkout').set(f.auth(body.accessToken)).set(f.idem()).send({ billingOptionId: 'monthly' }).expect(403);
    expect(checkout.body.error.code).toBe('tenant_context_unavailable');
  });
});

describe('platform policy', () => {
  test('GET → policy shape; tenant roles refused', async () => {
    const policy = await getPolicy();
    expect(policy).toMatchObject({ enabled: true, defaultDurationMinutes: 1440, maxDurationMinutes: 43200, revision: 1 });
    const refused = await f.api().get(`${PLATFORM}/policy`).set(f.auth(main.token)).expect(403);
    expect(refused.body.error.code).toBe('not_permitted');
  });

  test('validation: key required, integer minutes ≥ 60 and ≤ max', async () => {
    const noKey = await f.api().patch(`${PLATFORM}/policy`).set(f.auth(platform.token)).send({ defaultDurationMinutes: 120, expectedRevision: 1 }).expect(422);
    expect(noKey.body.error.fields).toHaveProperty(['Idempotency-Key']);
    for (const bad of [30, 90.5, 'abc', 43201]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patchPolicy({ defaultDurationMinutes: bad, expectedRevision: 1 }).expect(422);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.fields).toHaveProperty('defaultDurationMinutes');
    }
    const missingRev = await patchPolicy({ defaultDurationMinutes: 120 }).expect(422);
    expect(missingRev.body.error.fields).toHaveProperty('expectedRevision');
  });

  test('stale revision → 409 stale_demo_policy; unchanged → no bump', async () => {
    const policy = await getPolicy();
    const stale = await patchPolicy({ defaultDurationMinutes: 120, expectedRevision: policy.revision + 3 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_demo_policy', currentRevision: policy.revision });
    const same = await patchPolicy({ enabled: policy.enabled, defaultDurationMinutes: policy.defaultDurationMinutes, expectedRevision: policy.revision }).expect(200);
    expect(same.body.revision).toBe(policy.revision);
    expect(await f.models.AuditEvent.countDocuments({ action: 'customer_demo_policy_changed' })).toBe(0);
  });

  test('a duration change bumps the revision, is audited, and is NOT retroactive', async () => {
    const existing = await start().expect(201);
    const policy = await getPolicy();
    const res = await patchPolicy({ defaultDurationMinutes: 120, expectedRevision: policy.revision }).expect(200);
    expect(res.body).toMatchObject({
      defaultDurationMinutes: 120,
      revision: policy.revision + 1,
      updatedBy: { accountId: String(platform.account._id), displayName: platform.account.name },
    });
    expect(typeof res.body.updatedAt).toBe('string');

    const audit = await f.models.AuditEvent.findOne({ action: 'customer_demo_policy_changed' });
    expect(audit.actor.kind).toBe('platform_administrator');
    expect(JSON.parse(JSON.stringify(audit.changes))).toEqual([
      expect.objectContaining({ field: 'demo_default_duration', before: { kind: 'integer', value: 1440 }, after: { kind: 'integer', value: 120 } }),
    ]);

    const old = await f.models.DemoSession.findById(existing.body.demoSession.demoSessionId);
    expect(old.expiresAt.toISOString()).toBe(existing.body.demoSession.expiresAt);
    expect(old.policyRevision).toBe(policy.revision);

    const fresh = await start().expect(201);
    expect(fresh.body.demoSession.policyRevision).toBe(policy.revision + 1);
    const minutes = Math.round((new Date(fresh.body.demoSession.expiresAt) - new Date(fresh.body.demoSession.startedAt)) / 60000);
    expect(minutes).toBe(120);

    // Availability change is audited as a bool; restore both.
    const off = await patchPolicy({ enabled: false, expectedRevision: policy.revision + 1 }).expect(200);
    expect(off.body.enabled).toBe(false);
    const offAudit = await f.models.AuditEvent.findOne({ action: 'customer_demo_policy_changed' }).sort({ occurredAt: -1, _id: -1 });
    expect(JSON.parse(JSON.stringify(offAudit.changes[0]))).toMatchObject({ field: 'demo_availability', before: { kind: 'bool', value: true }, after: { kind: 'bool', value: false } });
    expect((await f.models.DemoSession.findById(fresh.body.demoSession.demoSessionId)).status).toBe('active');
    await patchPolicy({ enabled: true, defaultDurationMinutes: 1440, expectedRevision: off.body.revision }).expect(200);
  });
});

describe('platform sessions', () => {
  beforeAll(async () => {
    await f.models.DemoSession.deleteMany({});
  });

  test('list: active soonest-expiry first, then closed newest first; counts; paging; filter', async () => {
    const a = await start().expect(201);
    const b = await start().expect(201);
    const c = await start().expect(201);
    // b expires soonest, then c, then a.
    await f.models.DemoSession.updateOne({ _id: a.body.demoSession.demoSessionId }, { $set: { expiresAt: new Date(Date.now() + 5 * 3600000) } });
    await f.models.DemoSession.updateOne({ _id: b.body.demoSession.demoSessionId }, { $set: { expiresAt: new Date(Date.now() + 3600000) } });
    await f.models.DemoSession.updateOne({ _id: c.body.demoSession.demoSessionId }, { $set: { expiresAt: new Date(Date.now() + 7200000) } });
    const closed = await start().expect(201);
    await backdate(closed.body.demoSession.demoSessionId); // active by storage, expired by server time

    const res = await f.api().get(`${PLATFORM}/sessions`).set(f.auth(platform.token)).expect(200);
    expect(res.body.counts).toEqual({ active: 3, expired: 1, terminated: 0 });
    expect(res.body.items.map((s) => s.demoSessionId)).toEqual([
      b.body.demoSession.demoSessionId,
      c.body.demoSession.demoSessionId,
      a.body.demoSession.demoSessionId,
      closed.body.demoSession.demoSessionId,
    ]);
    expect(res.body.items[3].status).toBe('expired');
    res.body.items.forEach((s) => expect(s).not.toHaveProperty('resumeKeyHash'));

    const seen = [];
    let cursorValue;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await f.api().get(`${PLATFORM}/sessions`).query({ limit: 3, ...(cursorValue ? { cursor: cursorValue } : {}) }).set(f.auth(platform.token)).expect(200);
      seen.push(...page.body.items.map((s) => s.demoSessionId));
      cursorValue = page.body.nextCursor;
    } while (cursorValue);
    expect(seen).toEqual(res.body.items.map((s) => s.demoSessionId));

    const expiredOnly = await f.api().get(`${PLATFORM}/sessions?status=expired`).set(f.auth(platform.token)).expect(200);
    expect(expiredOnly.body.items.map((s) => s.demoSessionId)).toEqual([closed.body.demoSession.demoSessionId]);
    await f.api().get(`${PLATFORM}/sessions?status=selfEnded`).set(f.auth(platform.token)).expect(422);
  });

  test('terminate one: not_found / success (+revocation, audit) / not_active', async () => {
    const unknown = await f.api().post(`${PLATFORM}/sessions/demo_nope/terminate`).set(f.auth(platform.token)).set(f.idem()).expect(404);
    expect(unknown.body.error.code).toBe('demo_session_not_found');

    const { body } = await start().expect(201);
    const id = body.demoSession.demoSessionId;
    const res = await f.api().post(`${PLATFORM}/sessions/${id}/terminate`).set(f.auth(platform.token)).set(f.idem()).expect(200);
    expect(res.body).toMatchObject({ demoSessionId: id, status: 'terminated', terminationReason: 'super_admin_terminated' });
    const audit = await f.models.AuditEvent.findOne({ action: 'customer_demo_session_terminated', 'target.id': id });
    expect(audit.actor).toMatchObject({ kind: 'platform_administrator', id: String(platform.account._id) });
    await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(401);

    const again = await f.api().post(`${PLATFORM}/sessions/${id}/terminate`).set(f.auth(platform.token)).set(f.idem()).expect(409);
    expect(again.body.error.code).toBe('demo_session_not_active');
    await f.api().post(`${PLATFORM}/sessions/${id}/terminate`).set(f.auth(platform.token)).expect(422); // key required
  });

  test('terminate-all → { terminated: n }, each terminate_all + per-session audit', async () => {
    await f.models.DemoSession.deleteMany({});
    const s1 = await start().expect(201);
    const s2 = await start().expect(201);
    const gone = await start().expect(201);
    await backdate(gone.body.demoSession.demoSessionId);
    const res = await f.api().post(`${PLATFORM}/sessions/terminate-all`).set(f.auth(platform.token)).set(f.idem()).expect(200);
    expect(res.body).toEqual({ terminated: 2 });
    const rows = await f.models.DemoSession.find({ _id: { $in: [s1, s2].map((s) => s.body.demoSession.demoSessionId) } });
    rows.forEach((r) => expect(r).toMatchObject({ status: 'terminated', terminationReason: 'terminate_all' }));
    expect((await f.models.DemoSession.findById(gone.body.demoSession.demoSessionId)).status).toBe('expired');
    expect(
      await f.models.AuditEvent.countDocuments({ action: 'customer_demo_session_terminated', 'target.id': { $in: rows.map((r) => String(r._id)) } }),
    ).toBe(2);
  });

  test('cleanup removes ONLY expired rows; terminated rows and audit stay', async () => {
    const terminatedBefore = await f.models.DemoSession.countDocuments({ status: 'terminated' });
    const extra = await start().expect(201);
    await backdate(extra.body.demoSession.demoSessionId);
    const auditBefore = await f.models.AuditEvent.countDocuments();
    const expiredBefore = await f.models.DemoSession.countDocuments({ status: { $in: ['expired'] } });
    const res = await f.api().post(`${PLATFORM}/sessions/cleanup`).set(f.auth(platform.token)).set(f.idem()).expect(200);
    expect(res.body.removed).toBe(expiredBefore + 1); // + the one settled to expired now
    expect(await f.models.DemoSession.countDocuments({ status: 'expired' })).toBe(0);
    expect(await f.models.DemoSession.countDocuments({ status: 'terminated' })).toBe(terminatedBefore);
    // Only the settle's own expiry evidence was ADDED; nothing was removed.
    expect(await f.models.AuditEvent.countDocuments()).toBe(auditBefore + 1);
    await f.api().get(SESSION).set(f.auth(extra.body.accessToken)).expect(401);
  });
});

describe('job: expire-demo-sessions', () => {
  test('active past expiresAt → expired + audit + revoked credentials', async () => {
    const { body } = await start().expect(201);
    const id = body.demoSession.demoSessionId;
    await backdate(id);
    const n = await expireJob.run();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await f.models.DemoSession.findById(id)).status).toBe('expired');
    expect(await f.models.AuditEvent.countDocuments({ action: 'customer_demo_session_expired', 'target.id': id })).toBe(1);
    await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(401);
    await expireJob.run();
    expect(await f.models.AuditEvent.countDocuments({ action: 'customer_demo_session_expired', 'target.id': id })).toBe(1);
  });

  test('a trial marked expired by a read gets its credentials revoked by the job', async () => {
    const { body } = await start().expect(201);
    await backdate(body.demoSession.demoSessionId);
    await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(200);
    await expireJob.run();
    await f.api().get(SESSION).set(f.auth(body.accessToken)).expect(401);
  });
});
