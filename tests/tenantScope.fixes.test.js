/**
 * The data-layer team guard (models/plugins/tenantScope) in `enforce` mode
 * over the production call sites its `log` audit found (2026-10-09):
 * notification read state, the stale-write re-read, and platform analytics.
 * Each must run without a violation — a violation in `enforce` is a 500.
 */
const f = require('./helpers/factory');
const { saveVersioned } = require('../services/versioning');

const saved = process.env.TENANT_SCOPE_MODE;
let tenant;
let main;
let platform;

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  platform = await f.superAdmin();
  process.env.TENANT_SCOPE_MODE = 'enforce';
});

afterAll(() => {
  if (saved === undefined) delete process.env.TENANT_SCOPE_MODE;
  else process.env.TENANT_SCOPE_MODE = saved;
});

test('notification read and cleared state stay inside the team', async () => {
  const A = f.auth(main.token);
  await f.api().put('/api/v1/notifications/read').set(A).send({ ids: ['shiftUnderstaffed:s_1'] }).expect(200);
  await f.api().put('/api/v1/notifications/cleared').set(A).send({ ids: ['announcement:a_1'] }).expect(200);
  const state = await f.api().get('/api/v1/notifications/state').set(A).expect(200);
  expect(state.body.readIds).toContain('shiftUnderstaffed:s_1');
  expect(state.body.clearedIds).toContain('announcement:a_1');

  const det = await f.detachment(tenant);
  await f.api().get('/api/v1/notifications').query({ detachmentId: String(det._id) }).set(A).expect(200);
});

test("a lost race re-reads the record inside its own team", async () => {
  const group = await f.group(tenant);
  const Model = group.constructor;
  const mine = await Model.findOne({ _id: group._id, tenantId: String(tenant._id) });
  const theirs = await Model.findOne({ _id: group._id, tenantId: String(tenant._id) });
  theirs.notes = 'first';
  await theirs.save();

  mine.notes = 'second';
  await expect(saveVersioned(mine, (d) => d.toJSON())).rejects.toMatchObject({ code: 'stale_write' });
});

test('platform analytics count across teams, and say so', async () => {
  const P = f.auth(platform.token);
  await f.api().get('/api/v1/platform/analytics/summary').set(P).expect(200);
  await f.api().get('/api/v1/platform/analytics/tenants').set(P).expect(200);
});
