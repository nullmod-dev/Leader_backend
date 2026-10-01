/**
 * Platform insights — GET /platform/health and GET /platform/security-alerts.
 */
const f = require('./helpers/factory');
const { sha256 } = require('../utils/ids');

const { SecuritySignal, JobRun } = f.models;
const HOUR = 3600000;

let platform;

beforeAll(async () => {
  platform = await f.superAdmin();
});

const getHealth = async () => (await f.api().get('/api/v1/platform/health').set(f.auth(platform.token)).expect(200)).body;
const signalOf = (body, id) => body.signals.find((s) => s.id === id);

describe('GET /platform/health', () => {
  beforeEach(async () => {
    await JobRun.deleteMany({});
    await SecuritySignal.deleteMany({});
  });

  test('exactly three signals, typed and labelled', async () => {
    const body = await getHealth();
    expect(body.isPartial).toBe(false);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.signals.map((s) => s.id)).toEqual(['identity', 'background_jobs', 'files']);
    expect(body.signals.map((s) => s.label)).toEqual(['الهوية وتسجيل الدخول', 'المهام الخلفية', 'الملفات']);
    body.signals.forEach((s) => {
      expect(['healthy', 'degraded', 'unavailable', 'unknown']).toContain(s.status);
      expect(typeof s.summary).toBe('string');
      expect(Date.parse(s.observedAt)).not.toBeNaN();
    });
    expect(signalOf(body, 'identity').status).toBe('healthy');
    expect(signalOf(body, 'files').status).toBe('healthy');
    // No JobRun at all → unknown, never "healthy".
    expect(signalOf(body, 'background_jobs').status).toBe('unknown');
  });

  test('identity degrades above 50 failed sign-ins in the last hour', async () => {
    const now = Date.now();
    const docs = Array.from({ length: 51 }, () => ({ kind: 'sign_in_failed', emailHash: 'h', occurredAt: new Date(now - 60000) }));
    await SecuritySignal.insertMany(docs);
    expect(signalOf(await getHealth(), 'identity').status).toBe('degraded');
    // Older than an hour does not count.
    await SecuritySignal.updateMany({}, { $set: { occurredAt: new Date(now - 2 * HOUR) } });
    expect(signalOf(await getHealth(), 'identity').status).toBe('healthy');
  });

  test('background_jobs: failed → degraded, stale → degraded, fresh → healthy', async () => {
    await JobRun.create({ _id: 'expire-invitations', lastRunAt: new Date(), lastStatus: 'failed', runs: 1 });
    let body = await getHealth();
    expect(signalOf(body, 'background_jobs').status).toBe('degraded');
    expect(JSON.stringify(body)).not.toContain('lastError');

    await JobRun.updateOne({ _id: 'expire-invitations' }, { $set: { lastStatus: 'ok', lastRunAt: new Date(Date.now() - 3600000) } });
    expect(signalOf(await getHealth(), 'background_jobs').status).toBe('degraded');

    await JobRun.updateOne({ _id: 'expire-invitations' }, { $set: { lastRunAt: new Date() } });
    body = await getHealth();
    expect(signalOf(body, 'background_jobs').status).toBe('healthy');
  });

  test('a heartbeat for an unknown job name is ignored', async () => {
    await JobRun.create({ _id: 'no-such-job', lastRunAt: new Date(), lastStatus: 'failed', runs: 1 });
    expect(signalOf(await getHealth(), 'background_jobs').status).toBe('unknown');
  });
});

describe('GET /platform/security-alerts', () => {
  const email = 'victim@example.test';
  const hash = sha256(email);
  let tenant;
  let main;
  let body;

  beforeAll(async () => {
    await SecuritySignal.deleteMany({});
    ({ tenant, main } = await f.tenantWithMainAdmin({ displayName: 'فريق الأمان' }));
    const now = Date.now();
    const at = (minutesAgo) => new Date(now - minutesAgo * 60000);
    const many = (n, doc) => Array.from({ length: n }, (_, i) => ({ ...doc, occurredAt: at(10 + i) }));

    await SecuritySignal.insertMany([
      // 6 failures for one address (with a masked IP) → warning.
      ...many(6, { kind: 'sign_in_failed', emailHash: hash, ipMasked: '10.20.x.x', accountId: String(main.account._id) }),
      // 4 for another → below the per-address threshold.
      ...many(4, { kind: 'sign_in_failed', emailHash: sha256('other@example.test') }),
      // 10 without an address → counts only towards the platform total (20 → info).
      ...many(10, { kind: 'sign_in_failed' }),
      // Older than 24 h → ignored entirely.
      ...Array.from({ length: 30 }, () => ({ kind: 'sign_in_failed', emailHash: sha256('old@example.test'), occurredAt: new Date(now - 25 * HOUR) })),
      // Refresh replay on the Main Admin → critical with the tenant.
      { kind: 'refresh_replay', accountId: String(main.account._id), occurredAt: at(5) },
      // 10 Team Code link failures from one account → warning; 9 from another → nothing.
      ...many(10, { kind: 'team_link_failed', accountId: 'u_linker' }),
      ...many(9, { kind: 'team_link_failed', accountId: 'u_quiet' }),
      // 5 MFA failures on the Main Admin → warning with the tenant.
      ...many(5, { kind: 'mfa_failed', accountId: String(main.account._id) }),
    ]);
    body = (await f.api().get('/api/v1/platform/security-alerts').set(f.auth(platform.token)).expect(200)).body;
  });

  test('computes exactly the expected alerts, most severe first', () => {
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    const ids = body.alerts.map((a) => a.id);
    expect(ids).toHaveLength(5);
    expect(ids).toContain(`security_repeated_sign_in_${hash.slice(0, 8)}`);
    expect(ids).toContain('security_sign_in_failures_24h');
    expect(body.alerts[0].severity).toBe('critical');
    expect(body.alerts[0].id).toMatch(/^security_refresh_replay_/);
    expect(body.alerts.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning', 'warning', 'info']);
    body.alerts.forEach((a) => {
      expect(a.category).toBe('authentication');
      expect(Date.parse(a.detectedAt)).not.toBeNaN();
      expect(a.title).toMatch(/[؀-ۿ]/);
    });
  });

  test('affectedTenant is attached when the account belongs to a tenant', () => {
    const replay = body.alerts[0];
    expect(replay.affectedTenant).toEqual({ id: String(tenant._id), displayName: 'فريق الأمان', isDeleted: false });
    const mfa = body.alerts.find((a) => a.id.startsWith('security_mfa_'));
    expect(mfa.affectedTenant.id).toBe(String(tenant._id));
    const link = body.alerts.find((a) => a.id.startsWith('security_team_link_'));
    expect(link.affectedTenant).toBeUndefined();
    expect(body.alerts.find((a) => a.id === 'security_sign_in_failures_24h').description).toContain('20');
  });

  test('never contains the email, the full hash, an IP, a token or a Team Code', () => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(email);
    expect(text).not.toContain(hash);
    expect(text).not.toContain('10.20');
    expect(text).not.toContain(main.token);
    expect(text).not.toContain(tenant.teamCode);
    expect(text).not.toContain('u_linker');
    body.alerts.forEach((a) => expect(`${a.title} ${a.description}`).not.toContain(hash.slice(0, 8)));
  });

  test('an empty window is an empty list', async () => {
    await SecuritySignal.deleteMany({});
    const res = await f.api().get('/api/v1/platform/security-alerts').set(f.auth(platform.token)).expect(200);
    expect(res.body.alerts).toEqual([]);
  });
});
