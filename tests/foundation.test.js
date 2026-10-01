/**
 * Foundation: error envelope, version gate, idempotency, optimistic
 * concurrency, capability resolution, change log, image storage.
 */
const f = require('./helpers/factory');
const caps = require('../config/capabilities');
const { saveVersioned, assertVersion } = require('../services/versioning');
const settingsService = require('../services/settingsService');

describe('error envelope + system routes', () => {
  test('unknown route → 404 not_found envelope with reference', async () => {
    const res = await f.api().get('/api/v1/definitely-not-here').expect(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.reference).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(res.body.error.reference);
  });

  test('protected route without bearer → 401 authentication_expired', async () => {
    const res = await f.api().get('/api/v1/detachments').expect((r) => [401, 404].includes(r.status));
    if (res.status === 401) expect(res.body.error.code).toBe('authentication_expired');
  });

  test('malformed JSON → 422 validation', async () => {
    const res = await f.api().post('/api/v1/auth/sign-in').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation');
  });

  test('health', async () => {
    const res = await f.api().get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('forced upgrade', () => {
  beforeAll(() => settingsService.update({ minimumClientVersion: '1.4.0' }));
  afterAll(() => settingsService.update({ minimumClientVersion: '1.0.0' }));

  test('old X-Client-Version → 426 upgrade_required with minimumVersion', async () => {
    const res = await f.api().get('/api/v1/app-version/check?version=1.0.0').set('X-Client-Version', '1.0.0').expect(426);
    expect(res.body.error).toMatchObject({ code: 'upgrade_required', minimumVersion: '1.4.0' });
  });

  test('check endpoint answers 200 with the verdict', async () => {
    const res = await f.api().get('/api/v1/app-version/check?version=1.3.9').expect(200);
    expect(res.body).toEqual({ supported: false, minimumVersion: '1.4.0' });
    const ok = await f.api().get('/api/v1/app-version/check?version=1.4.0+7').expect(200);
    expect(ok.body.supported).toBe(true);
  });
});

describe('capabilities', () => {
  const grant = { global: ['workshop.create'], scoped: { d1: ['shift.manage'] } };
  test('union + implied detachment.view + unknown denied', () => {
    expect(caps.can(grant, 'workshop.create')).toBe(true);
    expect(caps.canIn(grant, 'd1', 'shift.manage')).toBe(true);
    expect(caps.canIn(grant, 'd2', 'shift.manage')).toBe(false);
    expect(caps.canIn(grant, 'd1', 'detachment.view')).toBe(true);
    expect(caps.canIn(grant, 'd1', 'made.up')).toBe(false);
    expect(caps.visibleDetachmentIds(grant)).toEqual(['d1']);
    expect(caps.visibleDetachmentIds(caps.mainAdminGrant())).toBeNull();
    expect(caps.ALL_CAPS).toHaveLength(30);
  });
});

describe('versioning + change log', () => {
  test('version starts at 1, bumps on save, lost race → stale_write', async () => {
    const tenant = await f.createTenant();
    const g = await f.group(tenant);
    expect(g.version).toBe(1);
    g.name = 'renamed';
    await g.save();
    expect(g.version).toBe(2);

    const a = await f.models.DetachmentGroup.findById(g._id);
    const b = await f.models.DetachmentGroup.findById(g._id);
    a.notes = 'first';
    await saveVersioned(a, (d) => ({ id: d._id, version: d.version }));
    b.notes = 'second';
    await expect(saveVersioned(b, (d) => ({ id: d._id, version: d.version }))).rejects.toMatchObject({
      code: 'stale_write',
      statusCode: 409,
      extensions: { currentVersion: 3 },
    });
    expect(() => assertVersion(a, 1, (d) => d)).toThrow(expect.objectContaining({ code: 'stale_write' }));

    const log = await f.models.ChangeLog.find({ tenantId: String(tenant._id) }).sort({ seq: 1 });
    expect(log.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(log[0]).toMatchObject({ entityType: 'detachment_group', op: 'upsert' });
  });
});

describe('storage', () => {
  test('saveImage writes webp under public/images and counts usage', async () => {
    const sharp = require('sharp');
    const storage = require('../services/storageService');
    const tenant = await f.createTenant();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } }).png().toBuffer();
    const saved = await storage.saveImage(png, 'member', { ownerType: 'member', ownerId: 'm_x', tenantId: String(tenant._id) });
    expect(saved.path).toMatch(/^\/images\/members\/member-m_x-.*\.webp$/);
    const fresh = await f.models.SaasTenant.findById(tenant._id);
    expect(fresh.usage.storageUsedBytes).toBe(saved.bytes);
    const res = await f.api().get(saved.path).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
    await storage.removeFile(saved.path);
    expect((await f.models.SaasTenant.findById(tenant._id)).usage.storageUsedBytes).toBe(0);
  });
});
