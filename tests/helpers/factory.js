/**
 * Test fixtures. Every helper writes straight to the models (fast, no HTTP)
 * and returns plain handles. Tokens come from tokenService, exactly as a real
 * sign-in would issue them.
 *
 *   const f = require('./helpers/factory');
 *   const { tenant, main } = await f.tenantWithMainAdmin();
 *   await f.api().get('/api/v1/detachments').set(f.auth(main.token)).expect(200);
 */
const request = require('supertest');
const app = require('../../app');
const models = require('../../models');
const tokenService = require('../../services/tokenService');
const settingsService = require('../../services/settingsService');
const { mainAdminGrant, grantFromKeys, SUB_ADMIN_PRESET } = require('../../config/capabilities');
const { generateTeamCode } = require('../../utils/normalize');
const { uuidV7, ulid } = require('../../utils/ids');
const { shiftWindow, todayIn } = require('../../utils/time');

const PASSWORD = 'Passw0rd!';

const api = () => request(app);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': uuidV7() });
const uniq = (p = '') => `${p}${ulid().slice(-8).toLowerCase()}`;
const fakeReq = { get: () => 'jest', ip: '127.0.0.1' };

const PLANS = [
  {
    _id: 'mtm_core',
    name: 'ليدر الأساسية',
    description: 'للفرق الصغيرة.',
    order: 1,
    defaultLimits: { detachment_groups: 2, detachments: 5, admins: 3, members: 75, workshops: 12, storage_bytes: 5368709120 },
  },
  {
    _id: 'mtm_standard',
    name: 'ليدر القياسية',
    description: 'للفرق النشطة متعددة المفارز.',
    recommended: true,
    order: 2,
    defaultLimits: { detachment_groups: 5, detachments: 15, admins: 8, members: 300, workshops: 40, storage_bytes: 21474836480 },
  },
  {
    _id: 'mtm_advanced',
    name: 'ليدر المتقدمة',
    description: 'للمنظمات الكبيرة.',
    order: 3,
    defaultLimits: { detachment_groups: 12, detachments: 40, admins: 20, members: 1000, workshops: 120, storage_bytes: 107374182400 },
  },
];

const ensurePlans = async () => {
  for (const p of PLANS) await models.Plan.updateOne({ _id: p._id }, { $set: p }, { upsert: true });
};

/** Issue a session for an account. */
const login = async (account, scope = 'full') => {
  const { session, accessToken, refreshToken } = await tokenService.createSession(account, scope, fakeReq);
  return { account, session, token: accessToken, refreshToken };
};

const createAccount = async (overrides = {}) => {
  const account = new models.Account({
    email: `${uniq('user')}@test.leader`,
    name: 'Test User',
    emailVerified: true,
    status: 'active',
    linkStatus: 'unlinked',
    ...overrides,
  });
  await account.setPassword(overrides.password || PASSWORD);
  await account.save();
  return account;
};

const superAdmin = async (overrides = {}) => {
  const account = await createAccount({ name: 'مدير منصة ليدر', role: 'super_admin', setupCompleted: true, ...overrides });
  return login(account);
};

const createTenant = async (overrides = {}) => {
  await ensurePlans();
  const now = new Date();
  const tenant = await models.SaasTenant.create({
    displayName: `فريق ${uniq()}`,
    teamCode: generateTeamCode(),
    subscription: { status: 'active', planId: 'mtm_standard', version: 1, renewsAt: new Date(now.getTime() + 365 * 86400000) },
    features: ['inventory', 'statistics_reports', 'workshops', 'announcements'].map((key) => ({ key, enabled: true, version: 1, updatedAt: now })),
    ...overrides,
  });
  return tenant;
};

const mainAdmin = async (tenant, overrides = {}) => {
  const account = await createAccount({
    name: 'سلمى الحارثي',
    role: 'main_admin',
    saasTenantId: String(tenant._id),
    capabilities: mainAdminGrant(),
    linkStatus: 'linked',
    setupCompleted: true,
    activatedAt: new Date(),
    ...overrides,
  });
  tenant.seat.currentAccountId = String(account._id);
  await tenant.save();
  return login(account);
};

/** A Simple Admin. `grant` defaults to the sub-admin preset held globally. */
const simpleAdmin = async (tenant, grant, overrides = {}) => {
  const account = await createAccount({
    name: 'مدير فرعي',
    role: 'admin',
    saasTenantId: String(tenant._id),
    capabilities: grant || grantFromKeys(SUB_ADMIN_PRESET),
    linkStatus: 'linked',
    setupCompleted: true,
    activatedAt: new Date(),
    ...overrides,
  });
  return login(account);
};

const tenantWithMainAdmin = async (tenantOverrides) => {
  const tenant = await createTenant(tenantOverrides);
  const main = await mainAdmin(tenant);
  return { tenant, main };
};

// ---- tenant operational fixtures --------------------------------------------------

const group = (tenant, overrides = {}) =>
  models.DetachmentGroup.create({ tenantId: String(tenant._id), name: `مجموعة ${uniq()}`, ...overrides });

const detachment = async (tenant, grp, overrides = {}) => {
  const g = grp || (await group(tenant));
  return models.Detachment.create({
    tenantId: String(tenant._id),
    detachmentGroupId: String(g._id),
    name: `مفرزة ${uniq()}`,
    region: 'دمشق',
    mainCenter: 'المركز الرئيسي',
    ...overrides,
  });
};

const member = (tenant, det, overrides = {}) =>
  models.TeamMember.create({
    tenantId: String(tenant._id),
    detachmentId: String(det._id),
    name: `متطوع ${uniq()}`,
    role: 'member',
    phone: '+963912345123',
    ...overrides,
  });

/** A shift on `date` (default today in tenant tz), 08:00–14:00. */
const shift = async (tenant, det, overrides = {}) => {
  const tz = tenant.timezone || 'Asia/Damascus';
  const date = overrides.date || todayIn(tz);
  const startMinutes = overrides.startMinutes ?? 480;
  const endMinutes = overrides.endMinutes ?? 840;
  const { startsAt, endsAt } = shiftWindow(date, startMinutes, endMinutes, tz);
  return models.Shift.create({
    tenantId: String(tenant._id),
    detachmentId: String(det._id),
    date,
    centerName: 'مركز الشعلان',
    startMinutes,
    endMinutes,
    needed: 3,
    startsAt,
    endsAt,
    ...overrides,
  });
};

const inventoryItem = (tenant, det, overrides = {}) =>
  models.InventoryItem.create({
    tenantId: String(tenant._id),
    detachmentId: String(det._id),
    name: `شاش ${uniq()}`,
    unit: 'علبة',
    currentStock: 10,
    minimum: 5,
    ...overrides,
  });

const workshop = (tenant, overrides = {}) =>
  models.Workshop.create({
    tenantId: String(tenant._id),
    name: `ورشة ${uniq()}`,
    at: new Date(Date.now() + 4 * 86400000),
    location: 'قاعة التدريب',
    capacity: 20,
    registrationFee: 25000,
    ...overrides,
  });

/** Most recent dev-mailbox code sent to `email`. */
const latestCode = async (email) => {
  const mail = await models.DevMail.findOne({ to: email.toLowerCase() }).sort({ createdAt: -1 });
  const m = mail && /(\d{4,10})/.exec(mail.text || '');
  return m ? m[1] : null;
};

const setSettings = (patch) => settingsService.update(patch);

/** Override one plan limit on a tenant (null removes the override). */
const setLimit = async (tenant, key, value) => {
  const path = `subscription.limitOverrides.${key}`;
  const update = value === null ? { $unset: { [path]: 1 } } : { $set: { [path]: value } };
  await models.SaasTenant.updateOne({ _id: tenant._id }, update);
  return models.SaasTenant.findById(tenant._id);
};

/** Enable/disable one tenant module. */
const setFeature = async (tenant, key, enabled) => {
  await models.SaasTenant.updateOne({ _id: tenant._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled }, $inc: { 'features.$.version': 1 } });
  return models.SaasTenant.findById(tenant._id);
};

module.exports = {
  PASSWORD,
  PLANS,
  api,
  auth,
  idem,
  uniq,
  ensurePlans,
  login,
  createAccount,
  superAdmin,
  createTenant,
  mainAdmin,
  simpleAdmin,
  tenantWithMainAdmin,
  group,
  detachment,
  member,
  shift,
  inventoryItem,
  workshop,
  latestCode,
  setSettings,
  setLimit,
  setFeature,
  models,
};
