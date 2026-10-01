/**
 * GET /sync/pull — the per-tenant change feed. Documents are written straight
 * through the models (the base plugin logs every upsert/delete), so these
 * tests do not depend on any other module's endpoints.
 */
const f = require('./helpers/factory');

const pull = (token, query = '') => f.api().get(`/api/v1/sync/pull${query}`).set(f.auth(token));

/** Follow the cursor to the end; returns every change. */
const drain = async (token, limit, cursor) => {
  const all = [];
  let next = cursor;
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await pull(token, `?limit=${limit}${next ? `&cursor=${next}` : ''}`).expect(200);
    all.push(...res.body.changes);
    next = res.body.nextCursor;
    if (!res.body.hasMore) break;
  }
  return { changes: all, cursor: next };
};

const world = async (tenantOverrides) => {
  const { tenant, main } = await f.tenantWithMainAdmin(tenantOverrides);
  const g1 = await f.group(tenant, { name: 'مجموعة دمشق' });
  const g2 = await f.group(tenant, { name: 'مجموعة الساحل' });
  const A = await f.detachment(tenant, g1, { name: 'مفرزة ألف' });
  const B = await f.detachment(tenant, g2, { name: 'مفرزة باء' });
  const mA = await f.member(tenant, A, { name: 'عضو ألف' });
  const mB = await f.member(tenant, B, { name: 'عضو باء' });
  const sA = await f.shift(tenant, A, { attendees: [{ memberId: String(mA._id), attendance: 'checkedIn' }] });
  const iB = await f.inventoryItem(tenant, B);
  const w = await f.workshop(tenant);
  const annA = await f.models.Announcement.create({
    tenantId: String(tenant._id),
    text: 'إعلان لمفرزة ألف',
    detachmentIds: [String(A._id)],
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  });
  const annB = await f.models.Announcement.create({
    tenantId: String(tenant._id),
    text: 'إعلان لمفرزة باء',
    detachmentIds: [String(B._id)],
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  });
  const scoped = await f.simpleAdmin(tenant, { global: [], scoped: { [String(A._id)]: ['detachment.view', 'member.view', 'member.contact.view'] } });
  return { tenant, main, scoped, g1, g2, A, B, mA, mB, sA, iB, w, annA, annB };
};

describe('GET /sync/pull', () => {
  test('from the beginning: every entity in seq order with its ordinary wire shape', async () => {
    const x = await world();
    const res = await pull(x.main.token).expect(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toEqual(expect.any(String));
    expect(res.body.serverTime).toEqual(expect.any(String));
    const { changes } = res.body;
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(changes.map((c) => c.entityType)).toEqual([
      'detachment_group',
      'detachment_group',
      'detachment',
      'detachment',
      'team_member',
      'team_member',
      'shift',
      'inventory_item',
      'workshop',
      'announcement',
      'announcement',
    ]);
    changes.forEach((c) => expect(c).toMatchObject({ op: 'upsert', version: 1, record: expect.objectContaining({ id: c.entityId }) }));

    const byId = new Map(changes.map((c) => [c.entityId, c.record]));
    expect(byId.get(String(x.g1._id))).toMatchObject({ name: 'مجموعة دمشق', detachmentCount: 1, memberCount: 1 });
    expect(byId.get(String(x.A._id))).toMatchObject({ name: 'مفرزة ألف', detachmentGroupId: String(x.g1._id), memberCount: 1 });
    expect(byId.get(String(x.mA._id))).toMatchObject({ name: 'عضو ألف', phoneMasked: expect.any(String) });
    expect(byId.get(String(x.mA._id))).not.toHaveProperty('phone');
    expect(byId.get(String(x.sA._id)).attendees[0]).toMatchObject({ id: String(x.mA._id), name: 'عضو ألف', attendance: 'checkedIn' });
    expect(byId.get(String(x.iB._id))).toMatchObject({ level: 'ok', currentStock: 10 });
    expect(byId.get(String(x.w._id))).toMatchObject({ registered: 0, guests: 0, archived: false });
    expect(byId.get(String(x.annA._id))).toMatchObject({ text: 'إعلان لمفرزة ألف', status: 'active' });
    expect(JSON.stringify(changes)).not.toContain('tenantId');
  });

  test('collapse to the last change per entity; tombstones for deletes', async () => {
    const x = await world();
    const { cursor } = await drain(x.main.token, 500);

    x.mA.name = 'عضو ألف المعدل';
    await x.mA.save();
    x.mA.department = 'الإسعاف';
    await x.mA.save();
    await x.mB.deleteOne();
    // An upsert whose document vanished without a tombstone still reads as a delete.
    const ghost = await f.member(x.tenant, x.A, { name: 'شبح' });
    await f.models.TeamMember.deleteOne({ _id: ghost._id });

    const res = await pull(x.main.token, `?cursor=${cursor}`).expect(200);
    expect(res.body.changes).toHaveLength(3);
    const [edited, removed, vanished] = res.body.changes;
    expect(edited).toMatchObject({ entityType: 'team_member', entityId: String(x.mA._id), op: 'upsert', version: 3 });
    expect(edited.record).toMatchObject({ name: 'عضو ألف المعدل', department: 'الإسعاف', version: 3 });
    expect(removed).toEqual({ seq: expect.any(Number), entityType: 'team_member', entityId: String(x.mB._id), op: 'delete', version: 1 });
    expect(removed).not.toHaveProperty('record');
    expect(vanished).toMatchObject({ entityId: String(ghost._id), op: 'delete' });
    expect(edited.seq).toBeLessThan(removed.seq);

    const latest = await f.models.ChangeLog.findOne({ tenantId: String(x.tenant._id), entityId: String(x.mA._id) }).sort({ seq: -1 });
    expect(edited.seq).toBe(latest.seq);
  });

  test('cursor paging covers everything exactly once', async () => {
    const x = await world();
    const page1 = await pull(x.main.token, '?limit=4').expect(200);
    expect(page1.body.changes).toHaveLength(4);
    expect(page1.body.hasMore).toBe(true);
    const rest = await drain(x.main.token, 4, page1.body.nextCursor);
    const ids = [...page1.body.changes, ...rest.changes].map((c) => c.entityId);
    expect(ids).toHaveLength(11);
    expect(new Set(ids).size).toBe(11);

    const idle = await pull(x.main.token, `?cursor=${rest.cursor}`).expect(200);
    expect(idle.body).toMatchObject({ changes: [], hasMore: false, nextCursor: rest.cursor });
  });

  test('since=now → no changes, cursor at the current head', async () => {
    const x = await world();
    const now = await pull(x.main.token, '?since=now').expect(200);
    expect(now.body.changes).toEqual([]);
    expect(now.body.hasMore).toBe(false);
    const status = await f.api().get('/api/v1/sync/status').set(f.auth(x.main.token)).expect(200);
    expect(status.body.latestSeq).toBe(11);

    await f.member(x.tenant, x.A, { name: 'جديد' });
    const after = await pull(x.main.token, `?cursor=${now.body.nextCursor}`).expect(200);
    expect(after.body.changes).toHaveLength(1);
    expect(after.body.changes[0].record.name).toBe('جديد');
  });

  test('visibility: a scoped admin sees only its detachments (+ their groups, org-level workshops)', async () => {
    const x = await world();
    const { changes } = await drain(x.scoped.token, 500);
    const ids = changes.map((c) => c.entityId).sort();
    expect(ids).toEqual(
      [x.g1, x.A, x.mA, x.sA, x.w, x.annA].map((d) => String(d._id)).sort(),
    );
    const { cursor } = await drain(x.scoped.token, 500);

    // A member transferred out of the caller's scope → a delete for it.
    x.mA.detachmentId = String(x.B._id);
    await x.mA.save();
    const moved = await pull(x.scoped.token, `?cursor=${cursor}`).expect(200);
    expect(moved.body.changes).toEqual([{ seq: expect.any(Number), entityType: 'team_member', entityId: String(x.mA._id), op: 'delete' }]);
    // …while the Main Admin simply sees the upsert.
    const mainView = await pull(x.main.token, `?cursor=${cursor}`).expect(200);
    expect(mainView.body.changes[0]).toMatchObject({ op: 'upsert', record: { detachmentId: String(x.B._id) } });

    // Deletes outside the scope are not leaked either.
    await x.iB.deleteOne();
    const after = await pull(x.scoped.token, `?cursor=${moved.body.nextCursor}`).expect(200);
    expect(after.body.changes).toEqual([]);
  });

  test('module entities disappear while their module is off', async () => {
    const x = await world({
      features: [
        { key: 'inventory', enabled: false },
        { key: 'statistics_reports', enabled: true },
        { key: 'workshops', enabled: false },
        { key: 'announcements', enabled: false },
      ],
    });
    const { changes } = await drain(x.main.token, 500);
    const types = new Set(changes.map((c) => c.entityType));
    expect([...types].sort()).toEqual(['detachment', 'detachment_group', 'shift', 'team_member']);
  });

  test('validation and authorization', async () => {
    const { main } = await f.tenantWithMainAdmin();
    await pull(main.token, '?cursor=not-a-cursor').expect(422);
    const bogus = Buffer.from(JSON.stringify({ v: 1, seq: -3 })).toString('base64url');
    await pull(main.token, `?cursor=${bogus}`).expect(422);
    await pull(main.token, '?limit=0').expect(422);
    await pull(main.token, '?limit=501').expect(422);
    await pull(main.token, '?since=yesterday').expect(422);
    await pull(main.token, '?limit=500').expect(200);
    await f.api().get('/api/v1/sync/pull').expect(401);
    const platform = await f.superAdmin();
    const res = await pull(platform.token).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
  });

  test('tenants never see each other', async () => {
    const x = await world();
    const other = await f.tenantWithMainAdmin();
    await f.group(other.tenant);
    const res = await pull(other.main.token).expect(200);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].entityId).not.toBe(String(x.g1._id));
  });
});
