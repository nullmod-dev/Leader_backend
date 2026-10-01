/**
 * Announcements: publish rules (text bounds, active targets, authority in
 * EVERY target, finite expiry, advisory publishedAt, required Idempotency-Key),
 * visibility, withdraw (authority in ANY target, idempotent), no delete.
 */
const f = require('./helpers/factory');

let tenant;
let main;
let dA;
let dB;
let dC;

const A = '/api/v1/announcements';
const hours = (n) => new Date(Date.now() + n * 3600000).toISOString();
const body = (over = {}) => ({
  text: 'تنبيه بخصوص شفت اليوم، يرجى الحضور مبكرا.',
  detachmentIds: [String(dA._id)],
  placements: ['detachment'],
  expiresAt: hours(24),
  ...over,
});
const publish = (token, b, key = f.idem()) => f.api().post(A).set(f.auth(token)).set(key).send(b);
const scoped = (map) => f.simpleAdmin(tenant, { global: [], scoped: map });

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  dA = await f.detachment(tenant);
  dB = await f.detachment(tenant);
  dC = await f.detachment(tenant);
});

describe('publish', () => {
  test('201: server-owned author and publishedAt; notifications always; unknown placements dropped; targets de-duplicated', async () => {
    const res = await publish(
      main.token,
      body({
        text: '   اجتماع المسؤولين يوم الخميس   ',
        detachmentIds: [String(dB._id), String(dA._id), String(dB._id)],
        placements: ['home', 'shifts', 'home'],
        publishedAt: '2020-01-01T00:00:00Z',
        authorName: 'منتحل',
      }),
    ).expect(201);
    expect(res.body).toMatchObject({
      text: 'اجتماع المسؤولين يوم الخميس',
      detachmentIds: [String(dB._id), String(dA._id)],
      placements: ['notifications', 'home'],
      status: 'active',
      authorName: main.account.name,
      version: 1,
    });
    expect(res.body.id).toMatch(/^a_/);
    expect(Math.abs(new Date(res.body.publishedAt).getTime() - Date.now())).toBeLessThan(60000);
    const stored = await f.models.Announcement.findById(res.body.id);
    expect(stored.authorId).toBe(String(main.account._id));
  });

  test('a client publishedAt within ±5 min is kept', async () => {
    const at = new Date(Date.now() - 2 * 60000);
    const res = await publish(main.token, body({ publishedAt: at.toISOString() })).expect(201);
    expect(res.body.publishedAt).toBe(at.toISOString());
  });

  test('Idempotency-Key is required and replays', async () => {
    const missing = await f.api().post(A).set(f.auth(main.token)).send(body()).expect(422);
    expect(missing.body.error.fields).toHaveProperty('Idempotency-Key');
    const key = f.idem();
    const b = body({ text: 'نص واحد يرسل مرتين' });
    const first = await publish(main.token, b, key).expect(201);
    const second = await publish(main.token, b, key).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await f.models.Announcement.countDocuments({ text: 'نص واحد يرسل مرتين' })).toBe(1);
  });

  test('validation: text bounds, targets, expiry', async () => {
    const field = async (b, name) => {
      const r = await publish(main.token, b).expect(422);
      expect(r.body.error.code).toBe('validation');
      expect(r.body.error.fields).toHaveProperty(name);
    };
    await field(body({ text: '  abc  ' }), 'text');
    await field(body({ text: 'ا'.repeat(501) }), 'text');
    await publish(main.token, body({ text: 'ا'.repeat(500) })).expect(201);
    await publish(main.token, body({ text: '  12345  ' })).expect(201);
    await field(body({ detachmentIds: [] }), 'detachmentIds');
    await field(body({ detachmentIds: ['d_ghost'] }), 'detachmentIds');
    const archived = await f.detachment(tenant, null, { status: 'archived' });
    await field(body({ detachmentIds: [String(dA._id), String(archived._id)] }), 'detachmentIds');
    const other = await f.createTenant();
    const foreign = await f.detachment(other);
    await field(body({ detachmentIds: [String(foreign._id)] }), 'detachmentIds');
    await field(body({ expiresAt: new Date(Date.now() - 1000).toISOString() }), 'expiresAt');
    await field(body({ expiresAt: 'tomorrow' }), 'expiresAt');
    await field(body({ expiresAt: undefined }), 'expiresAt');
  });

  test('authority in EVERY target: partial grant → 403 for the whole request', async () => {
    const admin = await scoped({ [String(dA._id)]: ['announcement.publish'], [String(dB._id)]: ['detachment.view'] });
    const before = await f.models.Announcement.countDocuments();
    const r = await publish(admin.token, body({ detachmentIds: [String(dA._id), String(dB._id)] })).expect(403);
    expect(r.body.error.code).toBe('not_permitted');
    expect(await f.models.Announcement.countDocuments()).toBe(before);
    await publish(admin.token, body({ detachmentIds: [String(dA._id)] })).expect(201);
    const none = await scoped({ [String(dA._id)]: ['detachment.view'] });
    await publish(none.token, body()).expect(403);
  });
});

describe('read + visibility', () => {
  test('list: only announcements addressing a viewable detachment, newest first; filters', async () => {
    const t = await f.createTenant();
    const admin = await f.mainAdmin(t);
    const x = await f.detachment(t);
    const y = await f.detachment(t);
    const z = await f.detachment(t);
    const make = (ids, minutesAgo, status = 'active') =>
      f.models.Announcement.create({
        tenantId: String(t._id),
        text: `إعلان ${minutesAgo}`,
        detachmentIds: ids.map((d) => String(d._id)),
        placements: ['notifications'],
        publishedAt: new Date(Date.now() - minutesAgo * 60000),
        expiresAt: new Date(Date.now() + 3600000),
        status,
      });
    const a1 = await make([x], 30);
    const a2 = await make([y, z], 10);
    const a3 = await make([z], 5, 'withdrawn');
    const a4 = await make([x, z], 1);

    const all = await f.api().get(A).set(f.auth(admin.token)).expect(200);
    expect(all.body.announcements.map((a) => a.id)).toEqual([a4, a3, a2, a1].map((a) => String(a._id)));

    const viewer = await f.simpleAdmin(t, { global: [], scoped: { [String(y._id)]: ['member.view'] } });
    const seen = await f.api().get(A).set(f.auth(viewer.token)).expect(200);
    expect(seen.body.announcements.map((a) => a.id)).toEqual([String(a2._id)]);
    await f.api().get(`${A}/${a2._id}`).set(f.auth(viewer.token)).expect(200);
    const hidden = await f.api().get(`${A}/${a1._id}`).set(f.auth(viewer.token)).expect(404);
    expect(hidden.body.error.code).toBe('not_found');

    const byStatus = await f.api().get(A).query({ status: 'withdrawn' }).set(f.auth(admin.token)).expect(200);
    expect(byStatus.body.announcements.map((a) => a.id)).toEqual([String(a3._id)]);
    const byDet = await f.api().get(A).query({ detachmentId: String(x._id) }).set(f.auth(admin.token)).expect(200);
    expect(byDet.body.announcements.map((a) => a.id)).toEqual([a4, a1].map((a) => String(a._id)));
    const viewerX = await f.api().get(A).query({ detachmentId: String(x._id) }).set(f.auth(viewer.token)).expect(200);
    expect(viewerX.body.announcements).toEqual([]);
    await f.api().get(A).query({ status: 'expired' }).set(f.auth(admin.token)).expect(422);
    await f.api().get(`${A}/a_missing`).set(f.auth(admin.token)).expect(404);
  });
});

describe('withdraw', () => {
  test('authority in ANY target; idempotent 200; not visible → 404; no delete', async () => {
    const created = await publish(main.token, body({ detachmentIds: [String(dA._id), String(dB._id)] })).expect(201);
    const id = created.body.id;

    const viewer = await scoped({ [String(dA._id)]: ['detachment.view'] });
    const refused = await f.api().post(`${A}/${id}/withdraw`).set(f.auth(viewer.token)).expect(403);
    expect(refused.body.error.code).toBe('not_permitted');
    const stranger = await scoped({ [String(dC._id)]: ['announcement.publish'] });
    await f.api().post(`${A}/${id}/withdraw`).set(f.auth(stranger.token)).expect(404);

    const partial = await scoped({ [String(dB._id)]: ['announcement.publish'] });
    const res = await f.api().post(`${A}/${id}/withdraw`).set(f.auth(partial.token)).expect(200);
    expect(res.body).toMatchObject({ id, status: 'withdrawn', version: 2 });
    const again = await f.api().post(`${A}/${id}/withdraw`).set(f.auth(main.token)).expect(200);
    expect(again.body).toMatchObject({ status: 'withdrawn', version: 2 });
    expect((await f.models.Announcement.findById(id)).withdrawnAt).toBeInstanceOf(Date);

    await f.api().delete(`${A}/${id}`).set(f.auth(main.token)).expect(404);
    expect(await f.models.Announcement.exists({ _id: id })).toBeTruthy();
  });
});

describe('feature + surface', () => {
  test('announcements disabled → 403 feature_disabled; super_admin → 403 tenant_context_unavailable', async () => {
    const t = await f.createTenant();
    t.features.find((x) => x.key === 'announcements').enabled = false;
    await t.save();
    const admin = await f.mainAdmin(t);
    const r = await f.api().get(A).set(f.auth(admin.token)).expect(403);
    expect(r.body.error).toMatchObject({ code: 'feature_disabled', feature: 'announcements' });
    await f.api().post(A).set(f.auth(admin.token)).set(f.idem()).send(body()).expect(403);
    const sa = await f.superAdmin();
    const r2 = await f.api().get(A).set(f.auth(sa.token)).expect(403);
    expect(r2.body.error.code).toBe('tenant_context_unavailable');
  });
});
