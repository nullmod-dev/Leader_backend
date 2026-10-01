/**
 * Tenant administration: /settings (notification prefs, organisation
 * profile + logo), /tenant/organization, /tenant/features.
 * Simple Admin management + tenant audit: tenant-admin-simple-admins.test.js.
 */
const sharp = require('sharp');
const f = require('./helpers/factory');
const { grantFromKeys, SUB_ADMIN_PRESET } = require('../config/capabilities');

const png = () => sharp({ create: { width: 48, height: 48, channels: 3, background: '#2a6' } }).png().toBuffer();

describe('GET/PUT /settings/notifications', () => {
  test('defaults, full replace, and any full session (platform too)', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const res = await f.api().get('/api/v1/settings/notifications').set(f.auth(main.token)).expect(200);
    expect(res.body).toEqual({ shiftReminders: true, stockAlerts: true, workshopUpdates: true, joinRequests: false });

    const next = { shiftReminders: false, stockAlerts: true, workshopUpdates: false, joinRequests: true };
    const put = await f.api().put('/api/v1/settings/notifications').set(f.auth(main.token)).send(next).expect(200);
    expect(put.body).toEqual(next);
    const again = await f.api().get('/api/v1/settings/notifications').set(f.auth(main.token)).expect(200);
    expect(again.body).toEqual(next);

    const platform = await f.superAdmin();
    await f.api().get('/api/v1/settings/notifications').set(f.auth(platform.token)).expect(200);
  });

  test('PUT requires all four real booleans → 422 validation', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const missing = await f.api()
      .put('/api/v1/settings/notifications')
      .set(f.auth(main.token))
      .send({ shiftReminders: true, stockAlerts: true, workshopUpdates: true })
      .expect(422);
    expect(missing.body.error.code).toBe('validation');
    expect(missing.body.error.fields).toHaveProperty('joinRequests');

    const stringly = await f.api()
      .put('/api/v1/settings/notifications')
      .set(f.auth(main.token))
      .send({ shiftReminders: 'true', stockAlerts: true, workshopUpdates: true, joinRequests: false })
      .expect(422);
    expect(stringly.body.error.fields).toHaveProperty('shiftReminders');
  });

  test('no session → 401 authentication_expired; onboarding session → 403', async () => {
    const res = await f.api().get('/api/v1/settings/notifications').expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
    const acc = await f.createAccount();
    const onboarding = await f.login(acc, 'onboarding');
    const r2 = await f.api().get('/api/v1/settings/notifications').set(f.auth(onboarding.token)).expect(403);
    expect(r2.body.error.code).toBe('onboarding_required');
  });
});

describe('/settings/organization', () => {
  test('GET → OrgInfo with active detachment + member counts (any tenant admin)', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const d1 = await f.detachment(tenant);
    await f.detachment(tenant, null, { status: 'archived' });
    await f.member(tenant, d1);
    await f.member(tenant, d1);
    await f.member(tenant, d1, { active: false });
    const simple = await f.simpleAdmin(tenant);

    const res = await f.api().get('/api/v1/settings/organization').set(f.auth(simple.token)).expect(200);
    expect(res.body).toEqual({
      name: tenant.displayName,
      legalName: '',
      address: '',
      emailPublic: '',
      detachmentCount: 1,
      memberCount: 2,
    });
    await f.api().get('/api/v1/settings/organization').set(f.auth(main.token)).expect(200);
  });

  test('platform session → 403 tenant_context_unavailable', async () => {
    const platform = await f.superAdmin();
    const res = await f.api().get('/api/v1/settings/organization').set(f.auth(platform.token)).expect(403);
    expect(res.body.error.code).toBe('tenant_context_unavailable');
  });

  test('PATCH with org.edit updates the profile; name/teamCode are platform-owned', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const res = await f.api()
      .patch('/api/v1/settings/organization')
      .set(f.auth(main.token))
      .send({ legalName: 'جمعية الهلال الطبية', address: 'دمشق — المزة', emailPublic: 'Info@Hilal.ORG' })
      .expect(200);
    expect(res.body).toMatchObject({ name: tenant.displayName, legalName: 'جمعية الهلال الطبية', address: 'دمشق — المزة', emailPublic: 'info@hilal.org' });

    const cleared = await f.api().patch('/api/v1/settings/organization').set(f.auth(main.token)).send({ emailPublic: '' }).expect(200);
    expect(cleared.body.emailPublic).toBe('');

    const owned = await f.api()
      .patch('/api/v1/settings/organization')
      .set(f.auth(main.token))
      .send({ name: 'Other', teamCode: 'MTM-AAAA-BBBB' })
      .expect(422);
    expect(owned.body.error.fields).toHaveProperty('name');
    expect(owned.body.error.fields).toHaveProperty('teamCode');
    const fresh = await f.models.SaasTenant.findById(tenant._id);
    expect(fresh.displayName).toBe(tenant.displayName);
    expect(fresh.teamCode).toBe(tenant.teamCode);
  });

  test('PATCH validation: bad email, empty body → 422', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const bad = await f.api().patch('/api/v1/settings/organization').set(f.auth(main.token)).send({ emailPublic: 'nope' }).expect(422);
    expect(bad.body.error.fields).toHaveProperty('emailPublic');
    await f.api().patch('/api/v1/settings/organization').set(f.auth(main.token)).send({}).expect(422);
  });

  test('PATCH without org.edit → 403 not_permitted', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    const res = await f.api().patch('/api/v1/settings/organization').set(f.auth(simple.token)).send({ address: 'x' }).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });

  test('logo upload → logoUrl, replace removes the old file, delete clears it', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const first = await f.api()
      .post('/api/v1/settings/organization/logo')
      .set(f.auth(main.token))
      .attach('image', await png(), 'logo.png')
      .expect(200);
    expect(first.body.logoUrl).toMatch(/^http:\/\/localhost:4000\/images\/tenants\/tenant-.*\.webp$/);
    const firstPath = first.body.logoUrl.replace('http://localhost:4000', '');
    await f.api().get(firstPath).expect(200);

    const second = await f.api()
      .post('/api/v1/settings/organization/logo')
      .set(f.auth(main.token))
      .attach('image', await png(), 'logo.png')
      .expect(200);
    expect(second.body.logoUrl).not.toBe(first.body.logoUrl);
    expect(await f.models.StoredFile.countDocuments({ path: firstPath })).toBe(0);

    const del = await f.api().delete('/api/v1/settings/organization/logo').set(f.auth(main.token)).expect(200);
    expect(del.body.logoUrl).toBeUndefined();
    const fresh = await f.models.SaasTenant.findById(tenant._id);
    expect(fresh.org.logoPath).toBeUndefined();
    expect(fresh.usage.storageUsedBytes).toBe(0);
  });

  test('logo: missing image → 422; no org.edit → 403', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    await f.api().post('/api/v1/settings/organization/logo').set(f.auth(main.token)).expect(422);
    const simple = await f.simpleAdmin(tenant);
    await f.api()
      .post('/api/v1/settings/organization/logo')
      .set(f.auth(simple.token))
      .attach('image', await png(), 'logo.png')
      .expect(403);
    await f.api().delete('/api/v1/settings/organization/logo').set(f.auth(simple.token)).expect(403);
  });
});

describe('GET /tenant/organization', () => {
  test('main admin (org.edit) sees usage; exact shape, no Team Code', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    await f.group(tenant);
    const res = await f.api().get('/api/v1/tenant/organization').set(f.auth(main.token)).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['limits', 'mainAdmin', 'organization', 'readAt', 'subscription']);
    expect(res.body.organization).toEqual({
      tenantId: String(tenant._id),
      displayName: tenant.displayName,
      lifecycleStatus: 'active',
      createdAt: tenant.createdAt.toISOString(),
    });
    expect(res.body.mainAdmin).toEqual({ displayName: 'سلمى الحارثي' });
    expect(res.body.subscription).toEqual({ status: 'active', planId: 'mtm_standard', renewsAt: tenant.subscription.renewsAt.toISOString() });
    expect(res.body.limits.usageIncluded).toBe(true);
    const groups = res.body.limits.items.find((i) => i.key === 'detachment_groups');
    expect(groups).toEqual({ key: 'detachment_groups', overridden: false, planDefault: 5, effective: 5, usage: 1 });
    expect(res.body.limits.items.map((i) => i.key)).toEqual([
      'detachment_groups',
      'detachments',
      'admins',
      'members',
      'workshops',
      'storage_bytes',
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(tenant.teamCode);
    expect(text).not.toMatch(/version|teamCode|reason|price/i);
  });

  test('a session without org.edit gets usageIncluded:false and no usage keys', async () => {
    const { tenant } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    const res = await f.api().get('/api/v1/tenant/organization').set(f.auth(simple.token)).expect(200);
    expect(res.body.limits.usageIncluded).toBe(false);
    res.body.limits.items.forEach((i) => expect(i).not.toHaveProperty('usage'));
    expect(res.body.limits.items[0]).toHaveProperty('effective');
  });

  test('override is reported; no plan → rows without planDefault/effective, planId null', async () => {
    const tenant = await f.createTenant({
      subscription: { status: 'trial', planId: null, version: 1, trialEndsAt: new Date(Date.now() + 5 * 86400000) },
    });
    const main = await f.mainAdmin(tenant);
    const res = await f.api().get('/api/v1/tenant/organization').set(f.auth(main.token)).expect(200);
    expect(res.body.subscription).toEqual({ status: 'trial', planId: null, trialEndsAt: tenant.subscription.trialEndsAt.toISOString() });
    res.body.limits.items.forEach((i) => {
      expect(i).not.toHaveProperty('planDefault');
      expect(i).not.toHaveProperty('effective');
    });

    const t2 = await f.createTenant();
    t2.subscription.limitOverrides.set('members', 7);
    await t2.save();
    const main2 = await f.mainAdmin(t2);
    const r2 = await f.api().get('/api/v1/tenant/organization').set(f.auth(main2.token)).expect(200);
    expect(r2.body.limits.items.find((i) => i.key === 'members')).toMatchObject({ overridden: true, planDefault: 300, effective: 7, usage: 0 });
  });

  test('no mainAdmin key when the seat is empty; platform → 403', async () => {
    const tenant = await f.createTenant();
    const simple = await f.simpleAdmin(tenant);
    const res = await f.api().get('/api/v1/tenant/organization').set(f.auth(simple.token)).expect(200);
    expect(res.body).not.toHaveProperty('mainAdmin');
    const platform = await f.superAdmin();
    await f.api().get('/api/v1/tenant/organization').set(f.auth(platform.token)).expect(403);
  });

  test('suspended tenant → 403 tenant_unavailable', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    tenant.lifecycle.status = 'suspended';
    await tenant.save();
    const res = await f.api().get('/api/v1/tenant/organization').set(f.auth(main.token)).expect(403);
    expect(res.body.error).toMatchObject({ code: 'tenant_unavailable', tenantStatus: 'suspended' });
  });
});

describe('GET /tenant/features', () => {
  test('all four keys in catalogue order', async () => {
    const tenant = await f.createTenant();
    tenant.features.find((x) => x.key === 'workshops').enabled = false;
    await tenant.save();
    const simple = await f.simpleAdmin(tenant, grantFromKeys(SUB_ADMIN_PRESET, []));
    const res = await f.api().get('/api/v1/tenant/features').set(f.auth(simple.token)).expect(200);
    expect(res.body.features).toEqual([
      { key: 'inventory', enabled: true },
      { key: 'statistics_reports', enabled: true },
      { key: 'workshops', enabled: false },
      { key: 'announcements', enabled: true },
    ]);
    expect(typeof res.body.readAt).toBe('string');
  });

  test('no session → 401', async () => {
    await f.api().get('/api/v1/tenant/features').expect(401);
  });
});
