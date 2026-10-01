/**
 * Platform insights — /platform/jobs and the expire-invitations job.
 */
const f = require('./helpers/factory');

const { Authorization, Account, JobRun } = f.models;
const DAY = 86400000;

let platform;
let tenant;

const authz = (overrides) =>
  Authorization.create({
    tenantId: String(tenant._id),
    kind: 'simple_admin',
    email: `${f.uniq('inv')}@test.leader`,
    role: 'admin',
    ...overrides,
  });

beforeAll(async () => {
  platform = await f.superAdmin();
  tenant = await f.createTenant();
});

describe('GET /platform/jobs', () => {
  test('every defined job is listed; never-run jobs carry nulls', async () => {
    await JobRun.deleteMany({});
    const res = await f.api().get('/api/v1/platform/jobs').set(f.auth(platform.token)).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const job = res.body.find((j) => j.name === 'expire-invitations');
    expect(job).toEqual({
      name: 'expire-invitations',
      description: expect.any(String),
      lastRunAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      lastError: null,
      runs: 0,
      lastAffected: null,
    });
    expect(res.body[0].name).toBe('expire-invitations');
  });
});

describe('POST /platform/jobs/:name/run — expire-invitations', () => {
  let expired;
  let linked;
  let fresh;
  let noExpiry;
  let accepted;
  let completedAccount;

  beforeAll(async () => {
    expired = await authz({ expiresAt: new Date(Date.now() - DAY) });
    linked = await f.createAccount({ linkStatus: 'linked', linkedAuthorizationId: String(expired._id) });
    // A finished account is never withdrawn, even if it still points at the row.
    completedAccount = await f.createAccount({ linkStatus: 'linked', linkedAuthorizationId: String(expired._id), setupCompleted: true });
    fresh = await authz({ expiresAt: new Date(Date.now() + DAY) });
    noExpiry = await authz({ expiresAt: null });
    accepted = await authz({ status: 'accepted', expiresAt: new Date(Date.now() - DAY) });
  });

  test('expires only past-due pending rows and withdraws their linked accounts', async () => {
    const res = await f.api().post('/api/v1/platform/jobs/expire-invitations/run').set(f.auth(platform.token)).expect(200);
    expect(res.body).toEqual({ name: 'expire-invitations', status: 'ok', affected: 1 });

    expect((await Authorization.findById(expired._id)).status).toBe('expired');
    expect((await Authorization.findById(fresh._id)).status).toBe('pending');
    expect((await Authorization.findById(noExpiry._id)).status).toBe('pending');
    expect((await Authorization.findById(accepted._id)).status).toBe('accepted');

    const acc = await Account.findById(linked._id);
    expect(acc.linkStatus).toBe('withdrawn');
    expect(acc.linkedAuthorizationId).toBeNull();
    expect((await Account.findById(completedAccount._id)).linkStatus).toBe('linked');

    const run = await JobRun.findById('expire-invitations');
    expect(run).toMatchObject({ lastStatus: 'ok', runs: 1, lastAffected: 1 });
    expect(run.lastRunAt).toBeInstanceOf(Date);
  });

  test('idempotent: a second run affects nothing and bumps the run count', async () => {
    const res = await f.api().post('/api/v1/platform/jobs/expire-invitations/run').set(f.auth(platform.token)).expect(200);
    expect(res.body.affected).toBe(0);
    const list = await f.api().get('/api/v1/platform/jobs').set(f.auth(platform.token)).expect(200);
    const job = list.body.find((j) => j.name === 'expire-invitations');
    expect(job).toMatchObject({ lastStatus: 'ok', runs: 2, lastAffected: 0, lastError: null });
    expect(Date.parse(job.lastRunAt)).not.toBeNaN();
    expect(Date.parse(job.lastSuccessAt)).not.toBeNaN();
  });

  test('unknown job → 404 not_found', async () => {
    const res = await f.api().post('/api/v1/platform/jobs/no-such-job/run').set(f.auth(platform.token)).expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('POST /platform/jobs/run', () => {
  test('runs every job and records a heartbeat for each', async () => {
    await authz({ expiresAt: new Date(Date.now() - 1000) });
    const res = await f.api().post('/api/v1/platform/jobs/run').set(f.auth(platform.token)).expect(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.find((r) => r.name === 'expire-invitations')).toEqual({ name: 'expire-invitations', status: 'ok', affected: 1 });
    const names = res.body.results.map((r) => r.name);
    const runs = await JobRun.find({ _id: { $in: names } });
    expect(runs).toHaveLength(names.length);

    const health = await f.api().get('/api/v1/platform/health').set(f.auth(platform.token)).expect(200);
    const jobs = health.body.signals.find((s) => s.id === 'background_jobs');
    const anyFailed = res.body.results.some((r) => r.status === 'failed');
    expect(jobs.status).toBe(anyFailed ? 'degraded' : 'healthy');
  });

  test('honours an Idempotency-Key (replay, no second run)', async () => {
    const key = f.idem();
    const first = await f.api().post('/api/v1/platform/jobs/expire-invitations/run').set(f.auth(platform.token)).set(key).expect(200);
    const before = (await JobRun.findById('expire-invitations')).runs;
    const replay = await f.api().post('/api/v1/platform/jobs/expire-invitations/run').set(f.auth(platform.token)).set(key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await JobRun.findById('expire-invitations')).runs).toBe(before);
  });
});
