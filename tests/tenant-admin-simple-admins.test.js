/**
 * Simple Admin management (/tenant/simple-admins, /tenant/simple-admin-invitations)
 * and the tenant audit stream (/tenant/audit).
 */
const f = require('./helpers/factory');
const authorizationService = require('../services/authorizationService');
const { grantFromKeys, SUB_ADMIN_PRESET } = require('../config/capabilities');

const list = (token) => f.api().get('/api/v1/tenant/simple-admins').set(f.auth(token));

const invite = (token, body, key) =>
  f.api()
    .post('/api/v1/tenant/simple-admin-invitations')
    .set(f.auth(token))
    .set(key ? { 'Idempotency-Key': key } : f.idem())
    .send(body);

const inviteBody = (overrides = {}) => ({
  invitedEmail: `${f.uniq('invitee')}@test.leader`,
  suggestedName: 'نورة العتيبي',
  capabilityKeys: ['detachment.view', 'member.view', 'shift.manage'],
  expectedRevision: 1,
  ...overrides,
});

describe('GET /tenant/simple-admins', () => {
  test('snapshot: revision, admins (not revoked), invitations newest first, assignable keys', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    await f.simpleAdmin(tenant, undefined, { status: 'revoked' });
    await invite(main.token, inviteBody({ invitedEmail: 'first@test.leader' })).expect(201);
    await invite(main.token, inviteBody({ invitedEmail: 'second@test.leader', expectedRevision: 2 })).expect(201);

    const res = await list(main.token).expect(200);
    expect(res.body.revision).toBe(3);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toMatchObject({
      id: String(simple.account._id),
      email: simple.account.email,
      name: 'مدير فرعي',
      status: 'active',
      lastLoginAt: null,
    });
    expect(res.body.accounts[0].capabilities.global).toEqual(expect.arrayContaining(['shift.manage']));
    expect(res.body.invitations.map((i) => i.email)).toEqual(['second@test.leader', 'first@test.leader']);
    expect(res.body.invitations[0]).toMatchObject({ status: 'pending', suggestedName: 'نورة العتيبي' });
    expect(res.body.assignableKeys).toContain('announcement.publish');
    expect(res.body.assignableKeys).not.toContain('admin.manage');
    expect(res.body.assignableKeys).not.toContain('org.edit');
    expect(typeof res.body.readAt).toBe('string');
  });

  test('assignable keys exclude disabled modules', async () => {
    const tenant = await f.createTenant({
      features: [
        { key: 'inventory', enabled: false },
        { key: 'statistics_reports', enabled: false },
        { key: 'workshops', enabled: true },
        { key: 'announcements', enabled: true },
      ],
    });
    const main = await f.mainAdmin(tenant);
    const res = await list(main.token).expect(200);
    expect(res.body.assignableKeys).not.toContain('inventory.adjust');
    expect(res.body.assignableKeys).not.toContain('inventory.item.manage');
    expect(res.body.assignableKeys).not.toContain('stats.view');
    expect(res.body.assignableKeys).toContain('workshop.create');
    expect(res.body.assignableKeys).toContain('member.view');
  });

  test('without admin.manage → 403 not_permitted', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    const res = await list(simple.token).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });
});

describe('POST /tenant/simple-admin-invitations', () => {
  test('201: pending invitation, scoped grant, revision bump, mail without Team Code, audit', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const det = await f.detachment(tenant);
    const res = await invite(
      main.token,
      inviteBody({
        email: 'Noura@Hilal-Medical.ORG',
        invitedEmail: undefined,
        capabilityKeys: ['member.view', 'shift.manage', 'workshop.create'],
        detachmentIds: [String(det._id)],
        // attempts to choose the tenant / role are ignored
        tenantId: 'saas_other',
        role: 'main_admin',
      }),
    ).expect(201);
    expect(res.body).toMatchObject({
      tenantId: String(tenant._id),
      email: 'noura@hilal-medical.org',
      suggestedName: 'نورة العتيبي',
      status: 'pending',
      capabilities: { global: ['workshop.create'], scoped: { [String(det._id)]: ['member.view', 'shift.manage'] } },
    });
    expect(new Date(res.body.expiresAt) > new Date()).toBe(true);

    const az = await f.models.Authorization.findById(res.body.id);
    expect(az).toMatchObject({ kind: 'simple_admin', role: 'admin', tenantId: String(tenant._id) });
    expect((await f.models.SaasTenant.findById(tenant._id)).adminManagementRevision).toBe(2);

    const mail = await f.models.DevMail.findOne({ to: 'noura@hilal-medical.org' });
    expect(mail.kind).toBe('simpleAdminInvitation');
    expect(mail.text).toContain(tenant.displayName);
    expect(mail.text).not.toContain(tenant.teamCode);

    const event = await f.models.AuditEvent.findOne({ action: 'admin_invitation_created' });
    expect(event).toMatchObject({ stream: 'tenant', tenantScopeId: String(tenant._id), category: 'admin_management' });
    expect(event.target).toMatchObject({ type: 'simple_admin_invitation', id: res.body.id });
    expect(JSON.stringify(event.toJSON())).not.toContain('noura@');
  });

  test('same Idempotency-Key + body → replayed, no second invitation', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const body = inviteBody();
    const key = `invite-${f.uniq()}`;
    const a = await invite(main.token, body, key).expect(201);
    const b = await invite(main.token, body, key).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(await f.models.Authorization.countDocuments({ email: body.invitedEmail })).toBe(1);
  });

  test('Idempotency-Key is required → 422', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const res = await f.api().post('/api/v1/tenant/simple-admin-invitations').set(f.auth(main.token)).send(inviteBody()).expect(422);
    expect(res.body.error.fields).toHaveProperty('Idempotency-Key');
  });

  test('validation: bad email, empty keys, missing revision, unassignable key, disabled module, foreign detachment', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const r1 = await invite(main.token, inviteBody({ invitedEmail: 'not-an-email' })).expect(422);
    expect(r1.body.error.fields).toHaveProperty('invitedEmail');
    await invite(main.token, inviteBody({ capabilityKeys: [] })).expect(422);
    await invite(main.token, inviteBody({ expectedRevision: undefined })).expect(422);
    await invite(main.token, inviteBody({ suggestedName: '' })).expect(422);

    const r2 = await invite(main.token, inviteBody({ capabilityKeys: ['member.view', 'admin.manage'] })).expect(422);
    expect(r2.body.error.fields.capabilityKeys).toMatch(/admin\.manage/);

    tenant.features.find((x) => x.key === 'inventory').enabled = false;
    await tenant.save();
    const r3 = await invite(main.token, inviteBody({ capabilityKeys: ['inventory.adjust'] })).expect(422);
    expect(r3.body.error.fields).toHaveProperty('capabilityKeys');

    const other = await f.createTenant();
    const foreign = await f.detachment(other);
    const r4 = await invite(main.token, inviteBody({ detachmentIds: [String(foreign._id)] })).expect(422);
    expect(r4.body.error.fields).toHaveProperty('detachmentIds');
    expect(await f.models.Authorization.countDocuments({ tenantId: String(tenant._id) })).toBe(0);
  });

  test('existing account or pending invitation → 409 admin_invitation_exists', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const taken = await f.createAccount();
    const r1 = await invite(main.token, inviteBody({ invitedEmail: taken.email.toUpperCase() })).expect(409);
    expect(r1.body.error.code).toBe('admin_invitation_exists');

    await invite(main.token, inviteBody({ invitedEmail: 'dup@test.leader' })).expect(201);
    const r2 = await invite(main.token, inviteBody({ invitedEmail: 'dup@test.leader', expectedRevision: 2 })).expect(409);
    expect(r2.body.error.code).toBe('admin_invitation_exists');

    // An EXPIRED pending invitation does not block a new one.
    await f.models.Authorization.updateOne({ email: 'dup@test.leader' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await invite(main.token, inviteBody({ invitedEmail: 'dup@test.leader', expectedRevision: 2 })).expect(201);
    expect((await f.models.SaasTenant.findById(tenant._id)).adminManagementRevision).toBe(3);
  });

  test('stale expectedRevision → 409 stale_admin_management', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const res = await invite(main.token, inviteBody({ expectedRevision: 5 })).expect(409);
    expect(res.body.error).toMatchObject({ code: 'stale_admin_management', currentRevision: 1 });
  });

  test('plan limit on admins → 409 plan_limit_reached', async () => {
    const tenant = await f.createTenant();
    tenant.subscription.limitOverrides.set('admins', 1);
    await tenant.save();
    const main = await f.mainAdmin(tenant);
    const res = await invite(main.token, inviteBody()).expect(409);
    expect(res.body.error).toMatchObject({ code: 'plan_limit_reached', limitKey: 'admins', limit: 1, usage: 1 });
  });

  test('without admin.manage → 403', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    await invite(simple.token, inviteBody()).expect(403);
  });
});

describe('invitation lifecycle', () => {
  test('invite → account signs up with that address → accepted, listed as an admin', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const address = `${f.uniq('life')}@test.leader`;
    const created = await invite(main.token, inviteBody({ invitedEmail: address, capabilityKeys: ['member.view', 'shift.assign'] })).expect(201);

    const account = await f.createAccount({ email: address, emailVerified: true, linkStatus: 'unlinked', setupCompleted: false });
    await authorizationService.refreshLinkState(account);
    expect(account.linkStatus).toBe('linked');
    await authorizationService.completeSetup(account, 'نورة العتيبي');

    const res = await list(main.token).expect(200);
    const listed = res.body.accounts.find((a) => a.email === address);
    expect(listed).toMatchObject({ name: 'نورة العتيبي', status: 'active', capabilities: { global: ['member.view', 'shift.assign'], scoped: {} } });
    expect(res.body.invitations.find((i) => i.id === created.body.id).status).toBe('accepted');
    expect(res.body.revision).toBe(3); // invite + accept
  });

  test('cancel: pending → cancelled, linked identity withdrawn; not pending → 409; unknown → 404; stale → 409', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const address = `${f.uniq('cancel')}@test.leader`;
    const created = await invite(main.token, inviteBody({ invitedEmail: address })).expect(201);
    const account = await f.createAccount({ email: address, emailVerified: true, setupCompleted: false });
    await authorizationService.refreshLinkState(account);

    const cancel = (id, rev, token = main.token) =>
      f.api()
        .post(`/api/v1/tenant/simple-admin-invitations/${id}/cancel`)
        .set(f.auth(token))
        .set(f.idem())
        .send({ expectedRevision: rev });

    const stale = await cancel(created.body.id, 1).expect(409);
    expect(stale.body.error.code).toBe('stale_admin_management');

    const res = await cancel(created.body.id, 2).expect(200);
    expect(res.body.status).toBe('cancelled');
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.linkStatus).toBe('withdrawn');
    expect(fresh.linkedAuthorizationId).toBeNull();

    const again = await cancel(created.body.id, 3).expect(409);
    expect(again.body.error.code).toBe('conflict');
    await cancel('az_missing', 3).expect(404);
    await f.api().post(`/api/v1/tenant/simple-admin-invitations/${created.body.id}/cancel`).set(f.auth(main.token)).send({ expectedRevision: 3 }).expect(422);
    await cancel(created.body.id, undefined).expect(422);
  });

  test('resend: fresh expiry + mail for pending/expired; cancelled → 409', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const address = `${f.uniq('resend')}@test.leader`;
    const created = await invite(main.token, inviteBody({ invitedEmail: address })).expect(201);
    await f.models.Authorization.updateOne({ _id: created.body.id }, { $set: { expiresAt: new Date(Date.now() - 60000) } });
    const expired = await list(main.token).expect(200);
    expect(expired.body.invitations[0].status).toBe('expired');

    const res = await f.api().post(`/api/v1/tenant/simple-admin-invitations/${created.body.id}/resend`).set(f.auth(main.token)).expect(200);
    expect(res.body.status).toBe('pending');
    expect(new Date(res.body.expiresAt) > new Date()).toBe(true);
    expect(await f.models.DevMail.countDocuments({ to: address })).toBe(2);

    await f.api()
      .post(`/api/v1/tenant/simple-admin-invitations/${created.body.id}/cancel`)
      .set(f.auth(main.token))
      .set(f.idem())
      .send({ expectedRevision: (await f.models.SaasTenant.findById(tenant._id)).adminManagementRevision })
      .expect(200);
    const refused = await f.api().post(`/api/v1/tenant/simple-admin-invitations/${created.body.id}/resend`).set(f.auth(main.token)).expect(409);
    expect(refused.body.error.code).toBe('conflict');
    await f.api().post('/api/v1/tenant/simple-admin-invitations/az_nope/resend').set(f.auth(main.token)).expect(404);
  });
});

describe('account commands', () => {
  test('PATCH capabilities: new grant, revision bump, audit; applies to the next request', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const det = await f.detachment(tenant);
    const simple = await f.simpleAdmin(tenant);
    const res = await f.api()
      .patch(`/api/v1/tenant/simple-admins/${simple.account._id}/capabilities`)
      .set(f.auth(main.token))
      .send({ capabilityKeys: ['member.view', 'stats.view'], detachmentIds: [String(det._id)], expectedRevision: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ id: String(simple.account._id), capabilities: { global: [], scoped: { [String(det._id)]: ['member.view', 'stats.view'] } } });
    expect((await f.models.SaasTenant.findById(tenant._id)).adminManagementRevision).toBe(2);
    const event = await f.models.AuditEvent.findOne({ action: 'admin_capabilities_changed' });
    expect(event.changes[0].after.value).toBe('member.view,stats.view');

    // The narrowed grant is what the next request is authorized with.
    const outside = await f.detachment(tenant);
    await f.api().get(`/api/v1/tenant/analytics/detachments/${det._id}`).set(f.auth(simple.token)).expect(200);
    const denied = await f.api().get(`/api/v1/tenant/analytics/detachments/${outside._id}`).set(f.auth(simple.token)).expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
  });

  test('capabilities: main admin → 403, other tenant/unknown → 404, bad key → 422, stale → 409', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const other = await f.tenantWithMainAdmin();
    const foreignAdmin = await f.simpleAdmin(other.tenant);
    const delegate = await f.simpleAdmin(tenant, grantFromKeys(['admin.manage', ...SUB_ADMIN_PRESET]));
    const simple = await f.simpleAdmin(tenant);
    const patch = (id, body, token = delegate.token) =>
      f.api().patch(`/api/v1/tenant/simple-admins/${id}/capabilities`).set(f.auth(token)).send(body);
    const body = { capabilityKeys: ['member.view'], expectedRevision: 1 };

    const r1 = await patch(main.account._id, body).expect(403);
    expect(r1.body.error.code).toBe('not_permitted');
    await patch(foreignAdmin.account._id, body).expect(404);
    await patch('u_nobody', body).expect(404);
    const self = await patch(delegate.account._id, body).expect(409);
    expect(self.body.error.code).toBe('conflict');
    await patch(simple.account._id, { ...body, capabilityKeys: ['org.edit'] }).expect(422);
    await patch(simple.account._id, { capabilityKeys: ['member.view'] }).expect(422);
    const stale = await patch(simple.account._id, { ...body, expectedRevision: 9 }).expect(409);
    expect(stale.body.error.code).toBe('stale_admin_management');
    await patch(simple.account._id, body, simple.token).expect(403);
  });

  test('suspend revokes sessions; reactivate restores; wrong state → 409; self → 409', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    await f.api().get('/api/v1/tenant/features').set(f.auth(simple.token)).expect(200);

    const res = await f.api()
      .post(`/api/v1/tenant/simple-admins/${simple.account._id}/suspend`)
      .set(f.auth(main.token))
      .send({ reason: 'مراجعة' })
      .expect(200);
    expect(res.body.status).toBe('suspended');
    const gone = await f.api().get('/api/v1/tenant/features').set(f.auth(simple.token)).expect(401);
    expect(gone.body.error.code).toBe('authentication_expired');
    await f.api().post(`/api/v1/tenant/simple-admins/${simple.account._id}/suspend`).set(f.auth(main.token)).send({}).expect(409);

    const back = await f.api().post(`/api/v1/tenant/simple-admins/${simple.account._id}/reactivate`).set(f.auth(main.token)).expect(200);
    expect(back.body.status).toBe('active');
    await f.api().post(`/api/v1/tenant/simple-admins/${simple.account._id}/reactivate`).set(f.auth(main.token)).expect(409);
    const fresh = await f.login(await f.models.Account.findById(simple.account._id));
    await f.api().get('/api/v1/tenant/features').set(f.auth(fresh.token)).expect(200);

    const self = await f.api().post(`/api/v1/tenant/simple-admins/${main.account._id}/suspend`).set(f.auth(main.token)).send({}).expect(409);
    expect(self.body.error.code).toBe('conflict');
    await f.api()
      .post(`/api/v1/tenant/simple-admins/${simple.account._id}/suspend`)
      .set(f.auth(main.token))
      .send({ reason: 'x'.repeat(300) })
      .expect(422);
    await f.api().post(`/api/v1/tenant/simple-admins/${simple.account._id}/suspend`).set(f.auth(fresh.token)).send({}).expect(403);

    const actions = (await f.models.AuditEvent.find({ tenantScopeId: String(tenant._id) })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['admin_suspended', 'admin_reactivated']));
  });
});

describe('GET /tenant/audit', () => {
  test('tenant-scoped events, newest first, cursor paging', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const other = await f.tenantWithMainAdmin();
    await invite(other.main.token, inviteBody()).expect(201);

    const a = await invite(main.token, inviteBody()).expect(201);
    await f.api()
      .post(`/api/v1/tenant/simple-admin-invitations/${a.body.id}/cancel`)
      .set(f.auth(main.token))
      .set(f.idem())
      .send({ expectedRevision: 2 })
      .expect(200);
    await invite(main.token, inviteBody({ expectedRevision: 3 })).expect(201);

    const page1 = await f.api().get('/api/v1/tenant/audit?limit=2').set(f.auth(main.token)).expect(200);
    expect(page1.body.items.map((e) => e.action)).toEqual(['admin_invitation_created', 'admin_invitation_cancelled']);
    expect(page1.body.items[0]).toMatchObject({ category: 'admin_management', actor: { kind: 'tenant_administrator', id: String(main.account._id) } });
    expect(page1.body.items[0]).not.toHaveProperty('stream');
    expect(page1.body.items[0]).not.toHaveProperty('tenantScopeId');
    expect(page1.body.items[0].tenant.id).toBe(String(tenant._id));
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await f.api().get(`/api/v1/tenant/audit?limit=2&cursor=${page1.body.nextCursor}`).set(f.auth(main.token)).expect(200);
    expect(page2.body.items.map((e) => e.action)).toEqual(['admin_invitation_created']);
    expect(page2.body.nextCursor).toBeNull();
  });

  test('validation (limit, cursor) and authorization', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    await f.api().get('/api/v1/tenant/audit?limit=0').set(f.auth(main.token)).expect(422);
    await f.api().get('/api/v1/tenant/audit?limit=101').set(f.auth(main.token)).expect(422);
    await f.api().get('/api/v1/tenant/audit?cursor=garbage').set(f.auth(main.token)).expect(422);
    const simple = await f.simpleAdmin(tenant);
    await f.api().get('/api/v1/tenant/audit').set(f.auth(simple.token)).expect(403);
  });
});
