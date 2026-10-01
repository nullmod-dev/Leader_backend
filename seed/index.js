/* eslint-disable no-console */
/**
 * `npm run seed`        — seed an EMPTY database (refuses if already seeded)
 * `npm run seed:reset`  — DROP the database, then seed
 *
 * Mirrors the Flutter mocks so the app's developer recognises every record:
 * 8 SaaS tenants (platform_tenant_fixtures.dart), the three dev personas
 * (demo_personas.dart), onboarding fixtures (mock_onboarding_repository.dart),
 * and the full operational data set of `saas_hilal` — groups, detachments,
 * 29 members, 17 inventory items with movements, two weeks of shifts with
 * attendance, 6 workshops with registers, 7 announcements.
 *
 * Every seeded account signs in with SEED_PASSWORD (default Leader@12345).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

const mongoose = require('mongoose');
const config = require('../config');
const models = require('../models');
const fx = require('./fixtures');
const { mainAdminGrant, grantFromKeys, SUB_ADMIN_PRESET } = require('../config/capabilities');
const { FEATURE_KEYS } = require('../config/constants');
const time = require('../utils/time');
const auditService = require('../services/auditService');
const settingsService = require('../services/settingsService');

const TZ = 'Asia/Damascus';
const DAY = 86400000;
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * DAY);
const daysAhead = (n) => new Date(now.getTime() + n * DAY);

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

const PLANS = [
  {
    _id: 'mtm_core',
    name: 'ليدر الأساسية',
    description: 'للفرق الصغيرة التي تبدأ بمفرزة أو اثنتين.',
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
    description: 'للمنظمات الكبيرة متعددة الفروع.',
    order: 3,
    defaultLimits: { detachment_groups: 12, detachments: 40, admins: 20, members: 1000, workshops: 120, storage_bytes: 107374182400 },
  },
];

const featureRows = (enabled) =>
  FEATURE_KEYS.map((key) => ({ key, enabled: enabled.includes(key), version: 1, updatedAt: now }));

const ALL_FEATURES = [...FEATURE_KEYS];

/** The 8 subscribers. `admin` = the seat holder account. */
const TENANTS = [
  {
    id: 'saas_hilal',
    displayName: 'فرق الهلال الطبية',
    teamCode: 'MTM-4K7P-QX92',
    createdDaysAgo: 612,
    subscription: { status: 'active', planId: 'mtm_advanced' },
    features: ALL_FEATURES,
    admin: { ...fx.accounts.mainAdmin, status: 'active' },
    usage: 7516192768,
  },
  {
    id: 'saas_najd',
    displayName: 'فريق نجد للاستجابة',
    teamCode: 'MTM-9WCT-3H5R',
    createdDaysAgo: 388,
    subscription: { status: 'active', planId: 'mtm_standard' },
    features: ['inventory', 'workshops', 'announcements'],
    admin: { id: 'ma_najd', email: 'badr@najd-response.sa', name: 'بدر العنزي', status: 'active' },
    replacement: { id: 'ma_najd_2', email: 'reem@najd-response.sa', name: 'ريم القحطاني', reason: 'طلبت الجهة تعيين مدير رئيسي جديد بعد انتقال المدير الحالي' },
    usage: 3221225472,
  },
  {
    id: 'saas_sahel',
    displayName: 'جمعية الساحل الصحية',
    teamCode: 'MTM-2FGD-8NVJ',
    createdDaysAgo: 205,
    subscription: { status: 'active', planId: 'mtm_standard', limitOverrides: { detachments: 10 } },
    features: ['inventory', 'statistics_reports', 'announcements'],
    admin: { id: 'ma_sahel', email: 'majed@sahel-health.org', name: 'ماجد الساحلي', status: 'suspended', suspendedDaysAgo: 3, reason: 'مراجعة صلاحيات الحساب' },
    usage: 1073741824,
  },
  {
    id: 'saas_wadi',
    displayName: 'فرق الوادي التطوعية',
    teamCode: 'MTM-7RMB-KZ64',
    createdDaysAgo: 96,
    subscription: { status: 'active', planId: 'mtm_core' },
    features: ['inventory', 'workshops', 'announcements'],
    admin: { id: 'ma_wadi', email: 'fahad@wadi-volunteers.org', name: 'فهد الوادي', status: 'active' },
    usage: 536870912,
  },
  {
    id: 'saas_nabd',
    displayName: 'فريق نبض التطوعي',
    teamCode: 'MTM-5JQX-2TWD',
    createdDaysAgo: 4,
    subscription: { status: 'trial', planId: null },
    features: ['inventory', 'announcements'],
    admin: { ...fx.accounts.nabdSeat, status: 'pending_setup' },
    usage: 0,
  },
  {
    id: 'saas_masar',
    displayName: 'مسار الإسعاف الأهلي',
    teamCode: 'MTM-6PTH-9BSK',
    createdDaysAgo: 11,
    subscription: { status: 'trial', planId: 'mtm_core' },
    features: ['inventory', 'announcements'],
    admin: { id: 'ma_masar', email: 'hala@masar-aid.org', name: 'هالة المسار', status: 'active' },
    usage: 104857600,
  },
  {
    id: 'saas_afiah',
    displayName: 'جمعية عافية',
    teamCode: 'MTM-3XDN-7VGM',
    createdDaysAgo: 466,
    subscription: { status: 'grace', planId: 'mtm_standard', graceChangedDaysAgo: 3, limitOverrides: { detachments: 20 } },
    features: ['inventory', 'workshops', 'statistics_reports', 'announcements'],
    admin: { id: 'ma_afiah', email: 'mona@afiah.org', name: 'منى عافية', status: 'active' },
    usage: 4508876800,
  },
  {
    id: 'saas_rukn',
    displayName: 'فريق الركن الطبي',
    teamCode: 'MTM-8SVZ-4CQR',
    createdDaysAgo: 731,
    lifecycle: { status: 'suspended', suspendedDaysAgo: 41, reason: 'مراجعة إدارية موثقة' },
    subscription: { status: 'inactive', planId: 'mtm_standard' },
    features: ['inventory', 'announcements'],
    admin: { id: 'ma_rukn', email: 'khalid@rukn-medical.org', name: 'خالد الركن', status: 'active' },
    usage: 2147483648,
  },
];

const nextAnniversary = (created) => {
  const d = new Date(created);
  while (d <= now) d.setFullYear(d.getFullYear() + 1);
  return d;
};

const createAccount = async (data, password = config.seedPassword) => {
  const account = new models.Account({ emailVerified: true, linkStatus: 'unlinked', ...data });
  if (password) await account.setPassword(password);
  await account.save();
  return account;
};

const seedPlatform = async () => {
  await settingsService.update({ minimumClientVersion: '1.0.0' });
  for (const p of PLANS) await models.Plan.create(p);

  const superAdmin = await createAccount({
    _id: fx.accounts.superAdmin.id,
    email: fx.accounts.superAdmin.email,
    name: fx.accounts.superAdmin.name,
    role: 'super_admin',
    status: 'active',
    setupCompleted: true,
    activatedAt: daysAgo(700),
  });

  const tenants = {};
  for (const t of TENANTS) {
    const createdAt = daysAgo(t.createdDaysAgo);
    const sub = { status: t.subscription.status, planId: t.subscription.planId, version: 1, limitOverrides: t.subscription.limitOverrides || {} };
    if (sub.status === 'trial') sub.trialEndsAt = new Date(createdAt.getTime() + 14 * DAY);
    if (sub.status === 'active') sub.renewsAt = nextAnniversary(createdAt);
    if (sub.status === 'grace') {
      sub.graceEndsAt = new Date(daysAgo(t.subscription.graceChangedDaysAgo).getTime() + 14 * DAY);
    }
    const lifecycle = { status: 'active', version: 1 };
    if (t.lifecycle && t.lifecycle.status === 'suspended') {
      lifecycle.status = 'suspended';
      lifecycle.version = 2;
      lifecycle.suspension = { suspendedAt: daysAgo(t.lifecycle.suspendedDaysAgo), reason: t.lifecycle.reason };
    }
    const tenant = await models.SaasTenant.create({
      _id: t.id,
      displayName: t.displayName,
      teamCode: t.teamCode,
      timezone: TZ,
      lifecycle,
      subscription: sub,
      features: featureRows(t.features),
      usage: { storageUsedBytes: t.usage, storageAllowanceBytes: null, lastActivityAt: t.createdDaysAgo > 5 ? daysAgo(1) : null },
      org: t.id === 'saas_hilal' ? { legalName: 'جمعية فرق الهلال الطبية التطوعية', address: 'دمشق — الشعلان', emailPublic: 'contact@hilal-medical.org' } : undefined,
      createdAt,
    });
    await models.SaasTenant.updateOne({ _id: t.id }, { $set: { createdAt } }, { timestamps: false });

    // Seat holder
    const a = t.admin;
    const pending = a.status === 'pending_setup';
    const account = await createAccount(
      {
        _id: a.id,
        email: a.email,
        name: a.name,
        role: pending ? null : 'main_admin',
        saasTenantId: pending ? null : t.id,
        capabilities: pending ? undefined : mainAdminGrant(),
        status: a.status,
        suspension: a.status === 'suspended' ? { suspendedAt: daysAgo(a.suspendedDaysAgo), reason: a.reason } : undefined,
        linkStatus: pending ? 'unlinked' : 'linked',
        setupCompleted: !pending,
        emailVerified: !pending,
        provisioned: pending,
        activatedAt: pending ? undefined : new Date(createdAt.getTime() + DAY),
        methods: pending ? [] : ['password'],
      },
      pending ? null : config.seedPassword,
    );
    await models.Authorization.create({
      _id: `az_${t.id.replace('saas_', '')}_seat`,
      tenantId: t.id,
      kind: 'initial_seat',
      email: a.email,
      role: 'main_admin',
      capabilities: mainAdminGrant(),
      suggestedName: a.name,
      accountId: String(account._id),
      linkedAccountId: pending ? null : String(account._id),
      status: pending ? 'pending' : 'accepted',
      expiresAt: pending ? new Date(createdAt.getTime() + 7 * DAY) : null,
      lastSentAt: createdAt,
      acceptedAt: pending ? undefined : new Date(createdAt.getTime() + DAY),
      createdBy: { accountId: fx.accounts.superAdmin.id, displayName: fx.accounts.superAdmin.name },
    });

    const seat = { revision: a.status === 'suspended' ? 3 : 1, currentAccountId: String(account._id) };
    if (t.replacement) {
      const r = t.replacement;
      const designate = await createAccount(
        { _id: r.id, email: r.email, name: r.name, status: 'pending_setup', provisioned: true, emailVerified: false, methods: [] },
        null,
      );
      const az = await models.Authorization.create({
        _id: `az_${t.id.replace('saas_', '')}_designate`,
        tenantId: t.id,
        kind: 'replacement_designate',
        email: r.email,
        role: 'main_admin',
        capabilities: mainAdminGrant(),
        suggestedName: r.name,
        accountId: String(designate._id),
        expiresAt: daysAhead(6),
        lastSentAt: daysAgo(1),
        createdBy: { accountId: fx.accounts.superAdmin.id, displayName: fx.accounts.superAdmin.name },
      });
      seat.revision = 2;
      seat.replacement = { id: 'mar_najd_1', status: 'pending', designateAccountId: String(designate._id), authorizationId: String(az._id), requestedAt: daysAgo(1), reason: r.reason };
    }
    await models.SaasTenant.updateOne({ _id: t.id }, { $set: { seat } });

    await models.TenantStatusEvent.create([
      { tenantId: t.id, type: 'tenant_created', occurredAt: createdAt },
      { tenantId: t.id, type: 'trial_started', occurredAt: createdAt },
      ...(sub.status === 'active' ? [{ tenantId: t.id, type: 'subscription_activated', occurredAt: new Date(createdAt.getTime() + 10 * DAY) }] : []),
      ...(sub.status === 'grace' ? [{ tenantId: t.id, type: 'moved_to_grace', occurredAt: daysAgo(t.subscription.graceChangedDaysAgo) }] : []),
      ...(lifecycle.status === 'suspended' ? [{ tenantId: t.id, type: 'tenant_suspended', occurredAt: lifecycle.suspension.suspendedAt, note: lifecycle.suspension.reason }] : []),
    ]);
    await auditService.record({
      action: 'tenant_registered',
      actor: superAdmin,
      target: { type: 'tenant', id: t.id, displayName: t.displayName },
      tenant: { id: t.id, displayName: t.displayName },
      occurredAt: createdAt,
    });
    if (sub.status === 'active') {
      await auditService.record({
        action: 'subscription_activated',
        actor: superAdmin,
        target: { type: 'subscription', id: t.id },
        tenant: { id: t.id, displayName: t.displayName },
        changes: [{ field: 'subscription_status', before: 'trial', after: 'active' }],
        occurredAt: new Date(createdAt.getTime() + 10 * DAY),
      });
    }
    tenants[t.id] = await models.SaasTenant.findById(t.id);
  }
  await auditService.record({
    action: 'tenant_suspended',
    actor: superAdmin,
    target: { type: 'tenant_lifecycle', id: 'saas_rukn' },
    tenant: { id: 'saas_rukn', displayName: 'فريق الركن الطبي' },
    changes: [{ field: 'lifecycle_status', before: 'active', after: 'suspended' }],
    occurredAt: daysAgo(41),
  });

  // A paid order for revenue analytics.
  await models.BillingOrder.create({
    _id: 'bo_seed_hilal',
    tenantId: 'saas_hilal',
    accountId: fx.accounts.mainAdmin.id,
    billingOptionId: 'twelve_months',
    months: 12,
    basePrice: { amount: 4000, currency: 'USD' },
    finalPrice: { amount: 4000, currency: 'USD' },
    planId: 'mtm_advanced',
    status: 'paid',
    paidAt: daysAgo(20),
    confirmedBy: { accountId: fx.accounts.superAdmin.id, displayName: fx.accounts.superAdmin.name },
    paymentReference: 'TRX-SEED-0001',
  });

  // Commerce seeds — disabled, like the Flutter control plane.
  await models.GlobalOffer.create({
    _id: 'offer_seed_try2',
    enabled: false,
    target: 'monthly',
    discount: { kind: 'fixed_final_price', finalPrice: { amount: 200, currency: 'USD' } },
    title: 'جرّب أول شهر بـ $2',
  });
  await models.Coupon.create({
    _id: 'coupon_seed_public',
    code: 'LEADER10',
    enabled: false,
    target: 'three_months',
    discount: { kind: 'percentage', percent: 10 },
    assignment: { kind: 'public' },
  });
  await models.Coupon.create({
    _id: 'coupon_seed_targeted',
    code: 'TRY2',
    enabled: false,
    target: 'monthly',
    discount: { kind: 'fixed_final_price', finalPrice: { amount: 200, currency: 'USD' } },
    assignment: { kind: 'account', accountId: fx.accounts.mainAdmin.id },
  });

  // Demo sessions for the operator list (one active, one expired).
  for (const d of [
    { id: 'demo_seed_active', startedHoursAgo: 3, durationHours: 24 },
    { id: 'demo_seed_expired', startedHoursAgo: 30, durationHours: 24 },
  ]) {
    const acc = await models.Account.create({ _id: `u_${d.id}`, name: 'زائر تجريبي', role: 'customer_demo', status: 'active', setupCompleted: true, demoSessionId: d.id });
    const startedAt = new Date(now.getTime() - d.startedHoursAgo * 3600000);
    await models.DemoSession.create({
      _id: d.id,
      accountId: String(acc._id),
      demoWorkspaceId: `dws_${d.id}`,
      displayName: 'زائر تجريبي',
      startedAt,
      expiresAt: new Date(startedAt.getTime() + d.durationHours * 3600000),
      status: d.id.endsWith('expired') ? 'expired' : 'active',
      policyRevision: 1,
    });
  }

  return { superAdmin, tenants };
};

// ---------------------------------------------------------------------------
// Onboarding fixtures + the Hilal Simple Admin
// ---------------------------------------------------------------------------

const seedAccounts = async () => {
  const a = fx.accounts;
  await createAccount({
    _id: a.simpleAdmin.id,
    email: a.simpleAdmin.email,
    name: a.simpleAdmin.name,
    role: 'admin',
    saasTenantId: fx.hilal.id,
    capabilities: {
      global: ['workshop.create', 'workshop.edit', 'workshop.people.manage', 'workshop.attendance.record'],
      scoped: Object.fromEntries(fx.hilal.simpleAdminDetachments.map((d) => [d, [...SUB_ADMIN_PRESET.filter((k) => !k.startsWith('workshop.')), 'announcement.publish']])),
    },
    status: 'active',
    linkStatus: 'linked',
    setupCompleted: true,
    activatedAt: daysAgo(90),
  });
  await models.Authorization.create({
    _id: 'az_hilal_simple_accepted',
    tenantId: fx.hilal.id,
    kind: 'simple_admin',
    email: a.simpleAdmin.email,
    role: 'admin',
    capabilities: grantFromKeys(SUB_ADMIN_PRESET, fx.hilal.simpleAdminDetachments),
    suggestedName: a.simpleAdmin.name,
    linkedAccountId: a.simpleAdmin.id,
    status: 'accepted',
    acceptedAt: daysAgo(90),
    lastSentAt: daysAgo(92),
    createdBy: { accountId: a.mainAdmin.id, displayName: a.mainAdmin.name },
  });

  // Pending Simple Admin invitation (auto-links when noura signs up).
  await models.Authorization.create({
    _id: 'az_hilal_admin',
    tenantId: fx.hilal.id,
    kind: 'simple_admin',
    email: a.invitedSimpleAdmin.email,
    role: 'admin',
    capabilities: grantFromKeys(SUB_ADMIN_PRESET, [fx.hilal.detachments.damCentral]),
    suggestedName: a.invitedSimpleAdmin.name,
    expiresAt: daysAhead(7),
    lastSentAt: now,
    createdBy: { accountId: a.mainAdmin.id, displayName: a.mainAdmin.name },
  });
  // An expired invitation for the management list.
  await models.Authorization.create({
    _id: 'az_hilal_expired',
    tenantId: fx.hilal.id,
    kind: 'simple_admin',
    email: 'late@hilal-medical.org',
    role: 'admin',
    capabilities: grantFromKeys(['detachment.view', 'member.view'], [fx.hilal.detachments.homs]),
    suggestedName: 'متأخر الدعوة',
    status: 'expired',
    expiresAt: daysAgo(1),
    lastSentAt: daysAgo(8),
    createdBy: { accountId: a.mainAdmin.id, displayName: a.mainAdmin.name },
  });

  await createAccount({ _id: a.unlinked.id, email: a.unlinked.email, name: a.unlinked.name, status: 'pending_setup', methods: ['password'] });
  await createAccount({ _id: a.unverified.id, email: a.unverified.email, name: a.unverified.name, status: 'pending_setup', emailVerified: false, methods: ['password'] });
};

// ---------------------------------------------------------------------------
// Hilal operational data
// ---------------------------------------------------------------------------

const GROUPS = [
  { _id: 't_damascus', name: 'الهلال الأحمر — فرع دمشق', notes: 'يضم مفرزات المدينة وريفها.', createdAt: new Date('2024-03-12T00:00:00Z') },
  { _id: 't_central', name: 'فرق الوسط التطوعية', notes: 'حمص وما حولها.', createdAt: new Date('2024-09-02T00:00:00Z') },
  { _id: 't_coast', name: 'تجمّع الساحل الإسعافي', createdAt: new Date('2025-01-20T00:00:00Z') },
];

const DETACHMENTS = [
  { _id: 'd_dam_central', detachmentGroupId: 't_damascus', name: 'مفرزة دمشق المركزية', region: 'دمشق', mainCenter: 'مركز الشعلان', notes: 'أعلى تغطية في الأسبوعين الماضيين.' },
  { _id: 'd_dam_rural', detachmentGroupId: 't_damascus', name: 'مفرزة ريف دمشق', region: 'ريف دمشق', mainCenter: 'مركز داريا', notes: 'نقص متكرر في الوردية المسائية.' },
  { _id: 'd_homs', detachmentGroupId: 't_central', name: 'مفرزة حمص', region: 'حمص', mainCenter: 'مركز الوعر' },
  { _id: 'd_coast', detachmentGroupId: 't_coast', name: 'مفرزة الساحل', region: 'اللاذقية', mainCenter: 'مركز اللاذقية' },
  { _id: 'd_north_arch', detachmentGroupId: 't_central', name: 'مفرزة الشمال — مؤرشفة', region: 'حلب', mainCenter: 'مركز الأشرفية', status: 'archived', notes: 'أُرشفت بعد دمج نشاطها مع مفرزة حمص.' },
];

// [id, name, department, personalNumber, role, detachmentId]
const MEMBERS = [
  ['m1', 'أحمد كنعان', 'الإسعاف', '101', 'shiftSupervisor', 'd_dam_central'],
  ['m2', 'ليلى ياسين', 'الإسعاف', '102', 'administrator', 'd_dam_central'],
  ['m3', 'سامي درويش', 'الإسعاف', '103', 'administrator', 'd_dam_central'],
  ['m4', 'نور الحسن', 'الإسناد اللوجستي', '104', 'member', 'd_dam_central'],
  ['m5', 'ياسر البكري', 'الإسناد اللوجستي', '105', 'member', 'd_dam_central'],
  ['m6', 'رنا سعيد', 'التدريب', '106', 'followUp', 'd_dam_central'],
  ['m7', 'طارق خالد', 'الاتصالات', '107', 'member', 'd_dam_central'],
  ['m8', 'دانا عمر', 'الإسعاف', '108', 'administrator', 'd_dam_central'],
  ['m9', 'علي منصور', 'الإسناد اللوجستي', '109', 'member', 'd_dam_central'],
  ['m10', 'هند شحادة', 'الاتصالات', '110', 'member', 'd_dam_central'],
  ['m11', 'ماجد صالح', 'الإسعاف', '201', 'shiftSupervisor', 'd_dam_rural'],
  ['m12', 'ريم قاسم', 'الإسعاف', '202', 'administrator', 'd_dam_rural'],
  ['m13', 'حسام عابد', 'الإسناد اللوجستي', '203', 'member', 'd_dam_rural'],
  ['m16', 'سلمى نجّار', 'الإسعاف', '204', 'administrator', 'd_dam_rural'],
  ['m17', 'بشار الأحمد', 'التدريب', '205', 'followUp', 'd_dam_rural'],
  ['m18', 'لمى حجازي', 'الاتصالات', '206', 'member', 'd_dam_rural'],
  ['m14', 'أمين رياض', 'الإسعاف', '301', 'shiftSupervisor', 'd_homs'],
  ['m19', 'غادة الحموي', 'الإسعاف', '302', 'administrator', 'd_homs'],
  ['m20', 'وسيم الديب', 'الإسناد اللوجستي', '303', 'member', 'd_homs'],
  ['m21', 'رغد الشامي', 'الاتصالات', '304', 'member', 'd_homs'],
  ['m22', 'فادي عزّام', 'التدريب', '305', 'followUp', 'd_homs'],
  ['m15', 'كنان عيسى', 'الإسعاف', '401', 'shiftSupervisor', 'd_coast'],
  ['m23', 'ميساء بدر', 'الإسعاف', '402', 'administrator', 'd_coast'],
  ['m24', 'رامي سلوم', 'الإسناد اللوجستي', '403', 'member', 'd_coast'],
  ['m25', 'جود الحلاق', 'الاتصالات', '404', 'member', 'd_coast'],
  ['m26', 'خالد العمر', 'الإسعاف', '501', 'shiftSupervisor', 'd_north_arch'],
  ['m27', 'سلمى الأحمد', 'الإسعاف', '502', 'administrator', 'd_north_arch'],
  ['m28', 'وسيم قدور', 'الإسناد اللوجستي', '503', 'member', 'd_north_arch'],
  ['m29', 'هبة الشيخ', 'الاتصالات', '504', 'member', 'd_north_arch'],
];

// [id, detachmentId, name, unit, stock, minimum, expiresInDays|null, unitsPerStrip, stripsPerCarton]
const ITEMS = [
  ['i1', 'd_dam_central', 'أدرينالين ١ ملغ/مل', 'أمبولة', 4, 12, 22, 1, 1],
  ['i2', 'd_dam_central', 'باراسيتامول ٥٠٠ ملغ', 'وحدة', 72, 240, 120, 12, 10],
  ['i3', 'd_dam_central', 'شاش طبي ١٠سم', 'رول', 32, 15, null, 1, 1],
  ['i4', 'd_dam_central', 'سالبوتامول بخّاخ', 'قطعة', 0, 6, 10, 1, 1],
  ['i5', 'd_dam_central', 'دِكستروز ٥٪', 'كيس', 24, 10, 300, 1, 1],
  ['i6', 'd_dam_rural', 'كمّامة N95', 'قطعة', 120, 30, null, 1, 1],
  ['i7', 'd_dam_rural', 'محلول ملحي ٠٫٩٪', 'كيس', 9, 18, 45, 1, 1],
  ['i8', 'd_dam_rural', 'قفازات معقّمة — قياس M', 'علبة', 14, 8, null, 1, 1],
  ['i9', 'd_homs', 'أتروبين ١ ملغ', 'أمبولة', 2, 8, 6, 1, 1],
  ['i10', 'd_homs', 'ضمادة ضاغطة', 'قطعة', 40, 20, null, 1, 1],
  ['i11', 'd_homs', 'ليدوكائين ٢٪', 'أمبولة', 0, 5, 200, 1, 1],
  ['i12', 'd_coast', 'جبيرة رقبة قابلة للتعديل', 'قطعة', 11, 6, null, 1, 1],
  ['i13', 'd_coast', 'أكسجين محمول ٢ لتر', 'أسطوانة', 3, 4, 400, 1, 1],
  ['i14', 'd_coast', 'شريط قياس سكر الدم', 'علبة', 7, 5, 14, 1, 1],
  ['i15', 'd_north_arch', 'شاش طبي ١٠سم', 'رول', 9, 10, null, 1, 1],
  ['i16', 'd_north_arch', 'محلول ملحي ٥٠٠مل', 'كيس', 14, 8, -5, 1, 1],
  ['i17', 'd_north_arch', 'قفازات معقّمة', 'علبة', 0, 4, null, 1, 1],
];

// Weekly plan: [weekdayIndex (0 = Saturday … 6 = Friday), period, center, needed, memberIds]
const PERIODS = { morning: [480, 840], evening: [840, 1200], night: [1200, 120] };
const SHIFT_PLAN = {
  d_dam_central: [
    [0, 'morning', 'مركز الشعلان', 8, ['m1', 'm2', 'm4', 'm7']],
    [0, 'evening', 'مركز الشعلان', 6, ['m3', 'm8']],
    [1, 'morning', 'مركز الشعلان', 6, ['m1', 'm10']],
    [2, 'evening', 'مركز المهاجرين', 8, ['m2']],
    [4, 'night', 'مركز المهاجرين', 5, []],
    [5, 'morning', 'مركز الشعلان', 7, ['m1', 'm5', 'm9']],
  ],
  d_dam_rural: [
    [0, 'morning', 'مركز داريا', 6, ['m11', 'm12', 'm16']],
    [2, 'evening', 'مركز صحنايا', 6, ['m13']],
    [3, 'morning', 'مركز داريا', 4, ['m11', 'm18']],
    [6, 'evening', 'مركز صحنايا', 5, ['m17']],
  ],
  d_homs: [
    [1, 'morning', 'مركز الوعر', 5, ['m14', 'm19']],
    [3, 'evening', 'مركز الوعر', 5, ['m20']],
    [5, 'night', 'مركز الوعر', 4, ['m14']],
  ],
  d_coast: [
    [0, 'morning', 'مركز اللاذقية', 4, ['m15', 'm23']],
    [4, 'evening', 'مركز جبلة', 5, ['m24']],
  ],
};

const phoneFor = (i) => `+9639${String(10000000 + i * 7919).slice(-8)}`;

/** Attendance for a finished shift: every 3rd attendee absent, the rest checked out. */
const completedAttendees = (memberIds, startsAt, endsAt) =>
  memberIds.map((memberId, i) =>
    i % 3 === 2
      ? { memberId, attendance: 'absent' }
      : {
          memberId,
          attendance: 'checkedOut',
          checkInAt: new Date(startsAt.getTime() + (i % 2) * 7 * 60000),
          checkOutAt: new Date(endsAt.getTime() - (i % 2) * 5 * 60000),
        },
  );

const seedHilal = async (superAdmin) => {
  const tenantId = fx.hilal.id;
  for (const g of GROUPS) {
    await models.DetachmentGroup.create({ ...g, tenantId });
    await models.DetachmentGroup.updateOne({ _id: g._id }, { $set: { createdAt: g.createdAt } }, { timestamps: false });
  }
  for (const d of DETACHMENTS) await models.Detachment.create({ status: 'active', ...d, tenantId });

  for (const [i, [id, name, department, personalNumber, role, detachmentId]] of MEMBERS.entries()) {
    await models.TeamMember.create({ _id: id, tenantId, detachmentId, name, department, personalNumber, role, phone: phoneFor(i + 1) });
  }

  const mainAdmin = await models.Account.findById(fx.accounts.mainAdmin.id);
  for (const [id, detachmentId, name, unit, stock, minimum, expiresIn, perStrip, perCarton] of ITEMS) {
    const expiresOn = expiresIn === null ? undefined : time.dayOf(daysAhead(expiresIn), TZ);
    const opening = stock + 20;
    await models.InventoryItem.create({ _id: id, tenantId, detachmentId, name, unit, currentStock: stock, minimum, expiresOn, unitsPerStrip: perStrip, stripsPerCarton: perCarton });
    await models.InventoryMovement.create({
      tenantId,
      detachmentId,
      itemId: id,
      itemName: name,
      direction: 'inflow',
      quantity: opening,
      convertedBaseUnitQuantity: opening,
      reason: 'رصيد افتتاحي',
      source: 'inventory_setup',
      performedBy: String(mainAdmin._id),
      performedByName: mainAdmin.name,
      stockBefore: 0,
      stockAfter: opening,
      at: daysAgo(30),
    });
    await models.InventoryMovement.create({
      tenantId,
      detachmentId,
      itemId: id,
      itemName: name,
      direction: 'outflow',
      quantity: 20,
      convertedBaseUnitQuantity: 20,
      reason: 'صرف للمناوبات',
      source: 'mobile_app',
      performedBy: String(mainAdmin._id),
      performedByName: mainAdmin.name,
      stockBefore: opening,
      stockAfter: stock,
      at: daysAgo(3),
    });
  }

  // Two weeks of shifts: last week (completed) + this week (current).
  const today = time.todayIn(TZ);
  const thisWeek = time.weekStartOf(today);
  const lastWeek = time.addDays(thisWeek, -7);
  let shiftCount = 0;
  for (const [detachmentId, plan] of Object.entries(SHIFT_PLAN)) {
    for (const [weekday, period, center, needed, members] of plan) {
      const [startMinutes, endMinutes] = PERIODS[period];
      const days = [time.addDays(lastWeek, weekday), time.addDays(thisWeek, weekday)];
      const template = await models.ShiftTemplate.create({ tenantId, detachmentId, centerName: center, dates: days, startMinutes, endMinutes, needed });
      for (const [w, date] of days.entries()) {
        const { startsAt, endsAt } = time.shiftWindow(date, startMinutes, endMinutes, TZ);
        const assigned = w === 0 ? members : members.slice(0, Math.max(0, members.length - 1));
        const finished = endsAt.getTime() < now.getTime() - 2 * 3600000;
        const attendees = finished ? completedAttendees(assigned, startsAt, endsAt) : assigned.map((memberId) => ({ memberId, attendance: 'notCheckedIn' }));
        await models.Shift.create({ tenantId, detachmentId, templateId: String(template._id), date, centerName: center, startMinutes, endMinutes, needed, startsAt, endsAt, attendees });
        shiftCount += 1;
      }
    }
  }
  // Archived detachment: finished history 3–4 weeks back, no template.
  for (const [weeksBack, weekday] of [
    [4, 0],
    [4, 2],
    [3, 0],
    [3, 3],
    [3, 5],
  ]) {
    const date = time.addDays(thisWeek, -7 * weeksBack + weekday);
    const { startsAt, endsAt } = time.shiftWindow(date, 480, 840, TZ);
    await models.Shift.create({
      tenantId,
      detachmentId: 'd_north_arch',
      date,
      centerName: 'مركز الأشرفية',
      startMinutes: 480,
      endMinutes: 840,
      needed: 4,
      startsAt,
      endsAt,
      attendees: completedAttendees(['m26', 'm27', 'm28', 'm29'], startsAt, endsAt),
    });
    shiftCount += 1;
  }

  // Today: a live shift covering "now" so check-in works immediately in Postman/the app.
  const nowMinutes = Math.floor((now.getTime() - time.dayMinutesToInstant(today, 0, TZ).getTime()) / 60000);
  const liveStart = Math.max(0, nowMinutes - 60);
  const liveEnd = Math.min(1440, nowMinutes + 180);
  const liveWindow = time.shiftWindow(today, liveStart, liveEnd, TZ);
  await models.Shift.create({
    _id: 'sh_live_today',
    tenantId,
    detachmentId: 'd_dam_central',
    date: today,
    centerName: 'مركز الشعلان — مناوبة حية',
    startMinutes: liveStart,
    endMinutes: liveEnd,
    needed: 4,
    startsAt: liveWindow.startsAt,
    endsAt: liveWindow.endsAt,
    attendees: [
      { memberId: 'm2', attendance: 'checkedIn', checkInAt: new Date(liveWindow.startsAt.getTime() + 5 * 60000) },
      { memberId: 'm6', attendance: 'notCheckedIn' },
    ],
  });
  shiftCount += 1;

  // Workshops
  const WORKSHOPS = [
    { _id: 'w1', name: 'الإسعاف الأولي المتقدم', at: daysAhead(4), location: 'قاعة التدريب — دمشق', capacity: 20, status: 'scheduled', registrationFee: 25000, organizers: ['m2', 'm8'] },
    { _id: 'w2', name: 'إدارة الحوادث الجماعية', at: daysAhead(10), location: 'مركز الشعلان', capacity: 30, status: 'scheduled', registrationFee: 40000, organizers: ['m1'] },
    { _id: 'w3', name: 'إنعاش قلبي رئوي — تجديد', at: daysAgo(7), location: 'مركز الوعر', capacity: 5, status: 'done', registrationFee: 15000, organizers: ['m14'] },
    { _id: 'w4', name: 'فرز المصابين في الميدان', at: daysAhead(2), location: 'مركز داريا', capacity: 3, status: 'scheduled', registrationFee: 0, organizers: [] },
    { _id: 'w5', name: 'التعامل مع حالات الاختناق', at: new Date(now.getTime() - 3600000), location: 'مركز اللاذقية', capacity: 12, status: 'ongoing', registrationFee: 20000, organizers: ['m15'] },
    { _id: 'w6', name: 'مبادئ الإسعاف للمتطوعين الجدد', at: daysAgo(25), location: 'قاعة التدريب — دمشق', capacity: 40, status: 'done', registrationFee: 10000, organizers: [] },
  ];
  // [workshopId, name, kind, role, attendance, paid]
  const PARTICIPANTS = [
    ['w1', 'سارة المصري', 'member', 'trainer', 'notCheckedIn', true],
    ['w1', 'محمد الحلبي', 'member', 'support', 'notCheckedIn', true],
    ['w1', 'لينا خوري', 'member', 'member', 'notCheckedIn', false],
    ['w1', 'عمر الشامي', 'guest', null, 'notCheckedIn', true],
    ['w1', 'هيا النجار', 'guest', null, 'notCheckedIn', false],
    ['w1', 'زياد العلي', 'guest', null, 'notCheckedIn', true],
    ['w2', 'يوسف القاسم', 'member', 'leader', 'notCheckedIn', true],
    ['w2', 'مريم الزعبي', 'member', 'member', 'notCheckedIn', false],
    ['w2', 'باسل حداد', 'guest', null, 'notCheckedIn', false],
    ['w3', 'عبير سلامة', 'member', 'trainer', 'checkedIn', true],
    ['w3', 'كريم الأيوبي', 'member', 'member', 'checkedIn', true],
    ['w3', 'رهف المحمد', 'member', 'member', 'absent', false],
    ['w3', 'جمال عيسى', 'guest', null, 'checkedIn', true],
    ['w3', 'نادين سليمان', 'guest', null, 'checkedIn', true],
    ['w4', 'تيم الحسيني', 'member', 'support', 'notCheckedIn', false],
    ['w4', 'روان الخطيب', 'member', 'member', 'notCheckedIn', false],
    ['w4', 'أنس بكور', 'guest', null, 'notCheckedIn', false],
    ['w5', 'شهد الرفاعي', 'member', 'leader', 'checkedIn', true],
    ['w5', 'حازم الجاسم', 'member', 'member', 'notCheckedIn', true],
    ['w5', 'إيمان داود', 'guest', null, 'checkedIn', false],
  ];
  for (const w of WORKSHOPS) {
    const { organizers, ...rest } = w;
    await models.Workshop.create({
      ...rest,
      tenantId,
      organizingTeam: organizers.map((memberId) => ({ memberId, attendance: w.status === 'done' ? 'checkedIn' : 'notCheckedIn' })),
    });
  }
  for (const [i, [workshopId, name, kind, role, attendance, paid]] of PARTICIPANTS.entries()) {
    await models.WorkshopParticipant.create({ _id: `p${i + 1}`, tenantId, workshopId, name, kind, role, attendance, paymentStatus: paid ? 'paid' : 'unpaid' });
  }

  // Announcements (a_seed_1..7)
  const author = { authorId: fx.accounts.mainAdmin.id, authorName: 'أحمد عبد الكريم' };
  const ANN = [
    ['a_seed_1', 'تنبيه بخصوص شفت ٤:٠٠–١٠:٠٠ اليوم، يرجى الحضور قبل بداية الشفت بـ١٥ دقيقة.', ['d_dam_central'], ['notifications', 'home', 'detachment'], -180, 21 * 60, 'active'],
    ['a_seed_2', 'اجتماع المسؤولين يوم الخميس الساعة ٧ مساءً في المركز الرئيسي. الحضور إلزامي لقادة المفارز.', ['d_dam_central', 'd_dam_rural', 'd_homs'], ['notifications'], -40, 12 * 60, 'active'],
    ['a_seed_3', 'انقطاع الماء عن مركز الشعلان اليوم. أحضروا معكم ماء الشرب.', ['d_dam_central'], ['notifications', 'home', 'detachment'], -12, 24 * 60, 'active'],
    ['a_seed_4', 'تم تحديث أرقام الطوارئ. راجعوا اللوحة في غرفة المناوبة.', ['d_dam_central'], ['notifications', 'detachment'], -240, 20 * 60, 'active'],
    ['a_seed_5', 'تدريب الإنعاش القلبي الرئوي أُجّل إلى الأسبوع القادم.', ['d_dam_central'], ['notifications', 'detachment'], -3 * 1440, -2 * 1440, 'active'],
    ['a_seed_6', 'طلب متطوعين إضافيين لشفت الليل — تم تأمين العدد، شكرا لكم.', ['d_homs'], ['notifications', 'detachment'], -360, 18 * 60, 'withdrawn'],
    ['a_seed_7', 'توزيع المستلزمات الجديدة على مراكز الساحل غدا صباحا.', ['d_coast'], ['notifications', 'home'], -30, 10 * 60, 'active'],
  ];
  for (const [id, text, detachmentIds, placements, publishedOffsetMin, expiresOffsetMin, status] of ANN) {
    await models.Announcement.create({
      _id: id,
      tenantId,
      text,
      detachmentIds,
      placements,
      publishedAt: new Date(now.getTime() + publishedOffsetMin * 60000),
      expiresAt: new Date(now.getTime() + expiresOffsetMin * 60000),
      status,
      withdrawnAt: status === 'withdrawn' ? daysAgo(0) : undefined,
      ...author,
    });
  }

  await auditService.record({
    stream: 'tenant',
    action: 'admin_invitation_created',
    actor: mainAdmin,
    target: { type: 'simple_admin_invitation', id: 'az_hilal_admin' },
    tenant: { id: tenantId, displayName: 'فرق الهلال الطبية' },
    changes: [{ field: 'invitation_status', after: 'pending' }],
  });

  return { groups: GROUPS.length, detachments: DETACHMENTS.length, members: MEMBERS.length, items: ITEMS.length, shifts: shiftCount, workshops: WORKSHOPS.length, participants: PARTICIPANTS.length, announcements: ANN.length, superAdmin: superAdmin.name };
};

// ---------------------------------------------------------------------------

const main = async () => {
  const reset = process.argv.includes('--reset');
  await mongoose.connect(config.mongoUri);
  console.log(`Connected → ${mongoose.connection.name}`);

  if (reset) {
    await mongoose.connection.dropDatabase();
    console.log('Database dropped.');
  } else if (await models.SaasTenant.exists({ _id: fx.hilal.id })) {
    console.log('Already seeded. Use `npm run seed:reset` to wipe and reseed.');
    await mongoose.disconnect();
    return;
  }
  await mongoose.syncIndexes();
  settingsService.invalidate();

  const { superAdmin } = await seedPlatform();
  await seedAccounts();
  const summary = await seedHilal(superAdmin);

  console.log('\nSeeded:');
  console.log(`  plans ${PLANS.length} · tenants ${TENANTS.length} · hilal →`, summary);
  console.log('\nSign in (password for all: %s):', config.seedPassword);
  console.log(`  Super Admin   ${fx.accounts.superAdmin.email}`);
  console.log(`  Main Admin    ${fx.accounts.mainAdmin.email}   (saas_hilal)`);
  console.log(`  Simple Admin  ${fx.accounts.simpleAdmin.email}   (saas_hilal: d_dam_central, d_homs)`);
  console.log(`  Onboarding    ${fx.accounts.unlinked.email} (verified, unlinked) · ${fx.accounts.unverified.email} (unverified)`);
  console.log(`  Invitation    ${fx.accounts.invitedSimpleAdmin.email} → sign up to auto-link as a Simple Admin`);
  console.log(`  Team Codes    saas_hilal ${fx.hilal.teamCode} · saas_nabd MTM-5JQX-2TWD (seat for ${fx.accounts.nabdSeat.email})`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
