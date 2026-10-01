/**
 * /platform/tenants/:tenantId/main-admin/** — the Main Admin seat through
 * authorizationService.seatSnapshot / seatCommands.
 */
const f = require('./helpers/factory');

const BASE = '/api/v1/platform/tenants';

let sa;

beforeAll(async () => {
  await f.ensurePlans();
  sa = await f.superAdmin();
});

const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
};

const registered = async () => {
  const res = await f
    .api()
    .post(BASE)
    .set(f.auth(sa.token))
    .set(f.idem())
    .send({ displayName: `فريق نجد للاستجابة ${f.uniq()}`, mainAdminName: 'بدر العنزي', mainAdminEmail: `${f.uniq('badr')}@najd-response.sa` })
    .expect(201);
  return res.body.id;
};

const seat = (tenantId, path, payload, token = sa.token) =>
  f.api().post(`${BASE}/${tenantId}/main-admin/${path}`).set(f.auth(token)).set(f.idem()).send(payload);

const read = async (tenantId) => (await f.api().get(`${BASE}/${tenantId}/main-admin`).set(f.auth(sa.token)).expect(200)).body;

describe('GET main-admin', () => {
  test('a registered tenant has a pending_setup holder with an outstanding invitation', async () => {
    const id = await registered();
    const snap = await read(id);
    expect(snap.tenant).toMatchObject({ tenantId: id, lifecycleStatus: 'active', lifecycleVersion: 1 });
    expect(snap.revision).toBe(1);
    expect(snap.current).toMatchObject({ displayName: 'بدر العنزي', status: 'pending_setup', setup: { status: 'outstanding' } });
    expect(snap.replacement).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/password|token|teamCode/i);
  });

  test('unknown tenant → 404 tenant_not_found', async () => {
    expectError(await f.api().get(`${BASE}/saas_nope/main-admin`).set(f.auth(sa.token)), 404, 'tenant_not_found');
  });
});

describe('seat commands', () => {
  test('resend setup → setup_resent, revision bumps; stale revision → stale_main_admin', async () => {
    const id = await registered();
    const res = await seat(id, 'setup/resend', { expectedRevision: 1, target: 'current' }).expect(200);
    expect(res.body.effect).toBe('setup_resent');
    expect(res.body.snapshot.revision).toBe(2);
    const stale = await seat(id, 'setup/resend', { expectedRevision: 1 });
    expectError(stale, 409, 'stale_main_admin');
    expect(stale.body.error.currentRevision).toBe(2);
    expectError(await seat(id, 'setup/resend', { expectedRevision: 2, target: 'replacement' }), 409, 'invalid_main_admin_transition');
    expectError(await seat(id, 'setup/resend', {}), 422, 'validation');
  });

  test('suspend ends every session of the holder; reactivate needs recent authentication', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const id = String(tenant._id);
    expectError(await seat(id, 'suspend', { expectedRevision: 1, reason: '   ' }), 422, 'invalid_main_admin_reason');

    const res = await seat(id, 'suspend', { expectedRevision: 1, reason: 'اشتباه في استخدام الحساب' }).expect(200);
    expect(res.body.effect).toBe('suspended');
    expect(res.body.snapshot.current).toMatchObject({ status: 'suspended', suspension: { reason: 'اشتباه في استخدام الحساب' } });
    expect((await f.models.Session.findById(main.session._id)).revokedAt).toBeInstanceOf(Date);

    // A Super Admin session authenticated long ago must re-authenticate first.
    const old = await f.superAdmin();
    await f.models.Session.updateOne({ _id: old.session._id }, { $set: { authenticatedAt: new Date(Date.now() - 3 * 3600000) } });
    const key = `seat-${f.uniq()}`;
    const refused = await f
      .api()
      .post(`${BASE}/${id}/main-admin/reactivate`)
      .set(f.auth(old.token))
      .set({ 'Idempotency-Key': key })
      .send({ expectedRevision: 2 });
    expectError(refused, 403, 'recent_authentication_required');
    expect(await f.models.IdempotencyRecord.countDocuments({ _id: new RegExp(`${key}$`) })).toBe(0);

    const back = await seat(id, 'reactivate', { expectedRevision: 2 }).expect(200);
    expect(back.body.effect).toBe('reactivated');
    expect(back.body.snapshot.current.status).toBe('active');
    expect(back.body.snapshot.current.suspension).toBeUndefined();
    expectError(await seat(id, 'reactivate', { expectedRevision: 3 }), 409, 'invalid_main_admin_transition');
    expect(await f.models.AuditEvent.countDocuments({ 'tenant.id': id, action: { $in: ['main_admin_suspended', 'main_admin_reactivated'] } })).toBe(2);
  });

  test('replace a pending_setup holder → immediate replaced', async () => {
    const id = await registered();
    const before = await read(id);
    const res = await seat(id, 'replacements', {
      expectedRevision: 1,
      designate: { displayName: 'ريم القحطاني', loginEmail: `${f.uniq('reem')}@najd-response.sa` },
      reason: 'عنوان التسجيل كان خاطئاً',
    }).expect(200);
    expect(res.body.effect).toBe('replaced');
    expect(res.body.snapshot.current).toMatchObject({ displayName: 'ريم القحطاني', status: 'pending_setup' });
    expect(res.body.snapshot.current.accountId).not.toBe(before.current.accountId);
    expect((await f.models.Account.findById(before.current.accountId)).status).toBe('revoked');

    const list = await f.api().get(`${BASE}/${id}`).set(f.auth(sa.token)).expect(200);
    expect(list.body.mainAdmin).toMatchObject({ name: 'ريم القحطاني', provisioning: 'pending_setup' });
  });

  test('replace an active holder → replacement_started, then cancel → replacement_cancelled', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const id = String(tenant._id);
    const started = await seat(id, 'replacements', {
      expectedRevision: 1,
      designate: { displayName: 'ريم القحطاني', loginEmail: `${f.uniq('reem')}@najd-response.sa` },
      reason: 'طلبت الجهة تعيين مدير رئيسي جديد',
    }).expect(200);
    expect(started.body.effect).toBe('replacement_started');
    const rep = started.body.snapshot.replacement;
    expect(rep).toMatchObject({ status: 'pending', designate: { displayName: 'ريم القحطاني', setup: { status: 'outstanding' } } });
    expect(started.body.snapshot.current.status).toBe('active');

    expectError(
      await seat(id, 'replacements', { expectedRevision: 2, designate: { displayName: 'آخر', loginEmail: `${f.uniq('x')}@x.org` }, reason: 'سبب' }),
      409,
      'main_admin_replacement_already_pending',
    );

    const cancelled = await seat(id, `replacements/${rep.id}/cancel`, { expectedRevision: 2 }).expect(200);
    expect(cancelled.body.effect).toBe('replacement_cancelled');
    expect(cancelled.body.snapshot.replacement).toBeUndefined();
    expect(cancelled.body.snapshot.revision).toBe(3);
    expectError(await seat(id, `replacements/${rep.id}/cancel`, { expectedRevision: 3 }), 409, 'invalid_main_admin_transition');
  });

  test('designate identity refusals', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const id = String(tenant._id);
    const taken = await f.createAccount();
    expectError(
      await seat(id, 'replacements', { expectedRevision: 1, designate: { displayName: 'مكرر', loginEmail: taken.email }, reason: 'سبب' }),
      409,
      'main_admin_identity_unavailable',
    );
    expectError(
      await seat(id, 'replacements', { expectedRevision: 1, designate: { displayName: 'بلا بريد', loginEmail: 'nope' }, reason: 'سبب' }),
      422,
      'invalid_main_admin_identity',
    );
    expectError(
      await seat(id, 'replacements', { expectedRevision: 1, designate: { displayName: 'بلا سبب', loginEmail: `${f.uniq('y')}@y.org` } }),
      422,
      'invalid_main_admin_reason',
    );
    expect((await read(id)).revision).toBe(1);
  });

  test('a suspended tenant refuses opening actions with tenant_not_eligible', async () => {
    const id = await registered();
    await f
      .api()
      .post(`${BASE}/${id}/lifecycle/suspend`)
      .set(f.auth(sa.token))
      .set(f.idem())
      .send({ reason: 'مراجعة', expectedVersion: 1 })
      .expect(200);
    expectError(await seat(id, 'setup/resend', { expectedRevision: 1 }), 409, 'tenant_not_eligible');
    const snap = await read(id);
    expect(snap.tenant.lifecycleStatus).toBe('suspended');
  });
});
