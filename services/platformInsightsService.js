/**
 * Super Admin insight reads (control plane only): Overview, Health, Security
 * alerts, the Audit Log read and the background-job heartbeat.
 *
 * Every function here returns platform facts and counts. Nothing here reads a
 * tenant's operational records (members, shifts, attendance, stock) or returns
 * a Team Code, an email, a token, an IP or a raw exception string.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const config = require('../config');
const AppError = require('../utils/appError');
const cursorUtil = require('../utils/cursor');
const { escapeRegex } = require('../utils/normalize');
const { sha256 } = require('../utils/ids');
const { iso } = require('../utils/time');
const jobs = require('../jobs');
const { SaasTenant, DemoSession, AuditEvent, SecuritySignal, JobRun, Account } = require('../models');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
const NOT_DELETED = { 'lifecycle.status': { $ne: 'deleted' } };

// ---- Arabic copy helpers -------------------------------------------------------------

/**
 * Arabic counted noun: 1 → «اشتراك واحد», 2 → «اشتراكان», 3–10 → «3 اشتراكات»,
 * 11+ → «11 اشتراكًا». Digits stay Western (the product's numeric style).
 */
const arCount = (n, [one, two, few, many]) => {
  if (n === 1) return one;
  if (n === 2) return two;
  const mod = n % 100;
  return mod >= 3 && mod <= 10 ? `${n} ${few}` : `${n} ${many}`;
};

const SUBSCRIPTIONS = ['اشتراك واحد', 'اشتراكان', 'اشتراكات', 'اشتراكًا'];

const short = (value) => sha256(String(value)).slice(0, 8);

/** Job definitions, tolerant of one broken definition file. */
const safeDefinitions = () => {
  try {
    return jobs.loadDefinitions();
  } catch (e) {
    return [];
  }
};

// ---- Health ---------------------------------------------------------------------------

const identitySignal = async (now) => {
  const base = { id: 'identity', label: 'الهوية وتسجيل الدخول', observedAt: iso(now) };
  try {
    await mongoose.connection.db.admin().ping();
  } catch (e) {
    return { ...base, status: 'unavailable', summary: 'تعذّر التحقق من خدمة تسجيل الدخول' };
  }
  const failures = await SecuritySignal.countDocuments({ kind: 'sign_in_failed', occurredAt: { $gte: new Date(now - HOUR) } });
  if (failures > 50) {
    return { ...base, status: 'degraded', summary: 'عدد غير معتاد من محاولات الدخول الفاشلة خلال الساعة الأخيرة' };
  }
  return { ...base, status: 'healthy', summary: 'تسجيل الدخول يعمل بشكل طبيعي' };
};

const jobsSignal = async (now) => {
  const base = { id: 'background_jobs', label: 'المهام الخلفية' };
  const names = safeDefinitions().map((d) => d.name);
  const runs = names.length ? await JobRun.find({ _id: { $in: names } }).lean() : [];
  if (!runs.length) {
    return { ...base, status: 'unknown', summary: 'لم تُسجَّل أي دورة تشغيل للمهام الخلفية بعد', observedAt: iso(now) };
  }
  const newest = runs.reduce((max, r) => (r.lastRunAt && (!max || r.lastRunAt > max) ? r.lastRunAt : max), null);
  const observedAt = iso(newest || now);
  if (runs.some((r) => r.lastStatus === 'failed')) {
    return { ...base, status: 'degraded', summary: 'تعذّر إكمال بعض المهام الخلفية في آخر تشغيل', observedAt };
  }
  const staleBefore = now - 3 * config.jobsIntervalSeconds * 1000;
  if (runs.some((r) => !r.lastRunAt || r.lastRunAt.getTime() < staleBefore)) {
    return { ...base, status: 'degraded', summary: 'تأخّر تشغيل بعض المهام الخلفية عن موعده', observedAt };
  }
  return { ...base, status: 'healthy', summary: 'المهام الخلفية تعمل في مواعيدها', observedAt };
};

const filesSignal = async (now) => {
  const base = { id: 'files', label: 'الملفات', observedAt: iso(now) };
  try {
    await fs.promises.access(IMAGES_DIR, fs.constants.W_OK);
    return { ...base, status: 'healthy', summary: 'رفع الصور وعرضها يعمل بشكل طبيعي' };
  } catch (e) {
    return { ...base, status: 'unavailable', summary: 'تعذّر الوصول إلى مساحة تخزين الملفات' };
  }
};

/** The three product-level signals, in catalogue order. */
const healthSignals = async (now = new Date()) =>
  Promise.all([identitySignal(now), jobsSignal(now), filesSignal(now)]);

const health = async (now = new Date()) => ({
  generatedAt: iso(now),
  isPartial: false,
  signals: await healthSignals(now),
});

// ---- Security alerts ------------------------------------------------------------------------

const groupStage = (key) => ({
  $group: {
    _id: key,
    count: { $sum: 1 },
    last: { $max: '$occurredAt' },
    accountIds: { $addToSet: '$accountId' },
    tenantIds: { $addToSet: '$tenantId' },
  },
});

/** A platform-safe tenant reference for a signal group, or undefined. */
const affectedTenantOf = async (group) => {
  let tenantId = (group.tenantIds || []).find(Boolean);
  if (!tenantId) {
    const accountIds = (group.accountIds || []).filter(Boolean);
    if (accountIds.length) {
      const account = await Account.findOne({ _id: { $in: accountIds }, saasTenantId: { $ne: null } }).select('saasTenantId').lean();
      tenantId = account && account.saasTenantId;
    }
  }
  if (!tenantId) return undefined;
  const tenant = await SaasTenant.findOne({ _id: tenantId, ...NOT_DELETED }).select('displayName').lean();
  return tenant ? { id: String(tenant._id), displayName: tenant.displayName, isDeleted: false } : undefined;
};

const alert = async (group, fields, { withTenant = true } = {}) => {
  const out = { ...fields, category: 'authentication', detectedAt: iso(group.last) };
  if (withTenant) {
    const affectedTenant = await affectedTenantOf(group);
    if (affectedTenant) out.affectedTenant = affectedTenant;
  }
  return out;
};

/**
 * Computed current-awareness snapshot over the last 24 h of SecuritySignal.
 * Never carries an email, a hash (outside the opaque id), an IP or a token.
 */
const securityAlerts = async (now = new Date()) => {
  const since = new Date(now - DAY);
  const [facets] = await SecuritySignal.aggregate([
    { $match: { occurredAt: { $gte: since, $lte: now } } },
    {
      $facet: {
        signInByEmail: [
          { $match: { kind: 'sign_in_failed', emailHash: { $type: 'string' } } },
          groupStage('$emailHash'),
          { $match: { count: { $gte: 5 } } },
        ],
        signInTotal: [{ $match: { kind: 'sign_in_failed' } }, groupStage(null)],
        replay: [{ $match: { kind: 'refresh_replay' } }, groupStage('$accountId')],
        deviceDenied: [{ $match: { kind: 'new_device_denied' } }, groupStage('$accountId')],
        teamLink: [
          { $match: { kind: 'team_link_failed', accountId: { $type: 'string' } } },
          groupStage('$accountId'),
          { $match: { count: { $gte: 10 } } },
        ],
        mfa: [
          { $match: { kind: 'mfa_failed', accountId: { $type: 'string' } } },
          groupStage('$accountId'),
          { $match: { count: { $gte: 5 } } },
        ],
      },
    },
  ]);

  const tasks = [];
  facets.replay.forEach((g) =>
    tasks.push(
      alert(g, {
        id: `security_refresh_replay_${short(g._id || 'unknown')}`,
        severity: 'critical',
        title: 'إعادة استخدام رمز جلسة سابق',
        description: `رُصدت محاولة لإعادة استخدام رمز تحديث مستهلك، فأُنهيت الجلسة المرتبطة احترازيًا. عدد الإشارات خلال آخر 24 ساعة: ${g.count}.`,
      }),
    ),
  );
  facets.deviceDenied.forEach((g) =>
    tasks.push(
      alert(g, {
        id: `security_device_denied_${short(g._id || 'unknown')}`,
        severity: 'critical',
        title: 'رفض مدير جهازاً جديداً على حسابه',
        description: `أكّد صاحب حساب إداري أن جهازاً جديداً سجّل الدخول إلى حسابه ليس جهازه، فحُظر الجهاز وأُنهيت كل جلسات الحساب وطُلبت إعادة تعيين كلمة المرور. عدد الحالات خلال آخر 24 ساعة: ${g.count}.`,
      }),
    ),
  );
  facets.signInByEmail.forEach((g) =>
    tasks.push(
      alert(g, {
        id: `security_repeated_sign_in_${String(g._id).slice(0, 8)}`,
        severity: 'warning',
        title: 'محاولات دخول فاشلة متكررة',
        description: `عدد محاولات الدخول الفاشلة لحساب واحد خلال آخر 24 ساعة: ${g.count}.`,
      }),
    ),
  );
  facets.teamLink.forEach((g) =>
    tasks.push(
      alert(g, {
        id: `security_team_link_${short(g._id)}`,
        severity: 'warning',
        title: 'محاولات متكررة لإدخال رمز فريق',
        description: `عدد المحاولات الفاشلة لربط حساب واحد برمز فريق خلال آخر 24 ساعة: ${g.count}.`,
      }),
    ),
  );
  facets.mfa.forEach((g) =>
    tasks.push(
      alert(g, {
        id: `security_mfa_${short(g._id)}`,
        severity: 'warning',
        title: 'إخفاق متكرر في التحقق بخطوتين',
        description: `عدد رموز التحقق بخطوتين الخاطئة لحساب واحد خلال آخر 24 ساعة: ${g.count}.`,
      }),
    ),
  );
  const total = facets.signInTotal[0];
  if (total && total.count >= 20) {
    tasks.push(
      alert(
        total,
        {
          id: 'security_sign_in_failures_24h',
          severity: 'info',
          title: 'ارتفاع محاولات الدخول الفاشلة',
          description: `إجمالي محاولات الدخول الفاشلة على المنصة خلال آخر 24 ساعة: ${total.count}.`,
        },
        { withTenant: false },
      ),
    );
  }

  const alerts = await Promise.all(tasks);
  alerts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.detectedAt.localeCompare(a.detectedAt) || a.id.localeCompare(b.id));
  return alerts;
};

const securityAlertsSnapshot = async (now = new Date()) => ({ generatedAt: iso(now), alerts: await securityAlerts(now) });

// ---- Jobs -----------------------------------------------------------------------------------

const jobRow = (def, run) => ({
  name: def ? def.name : run._id,
  description: def ? def.description || null : null,
  lastRunAt: run ? iso(run.lastRunAt) : null,
  lastSuccessAt: run ? iso(run.lastSuccessAt) : null,
  lastStatus: run ? run.lastStatus || null : null,
  lastError: run ? run.lastError || null : null,
  runs: run ? run.runs || 0 : 0,
  lastAffected: run && run.lastAffected !== undefined ? run.lastAffected : null,
});

/** Every known job (never-run ones with nulls), then any orphan heartbeat. */
const listJobs = async () => {
  const defs = safeDefinitions();
  const runs = await JobRun.find().lean();
  const byName = new Map(runs.map((r) => [r._id, r]));
  const rows = defs.map((d) => jobRow(d, byName.get(d.name)));
  const known = new Set(defs.map((d) => d.name));
  runs
    .filter((r) => !known.has(r._id))
    .sort((a, b) => a._id.localeCompare(b._id))
    .forEach((r) => rows.push(jobRow(null, r)));
  return rows;
};

const runAllJobs = async () => ({ results: await jobs.runAll() });

const runOneJob = async (name) => {
  const def = safeDefinitions().find((d) => d.name === name);
  if (!def) throw AppError.notFound('job');
  return jobs.runJob(def);
};

// ---- Overview --------------------------------------------------------------------------------

const ACTIVITY_OF = {
  tenant_registered: { type: 'tenant_created', title: 'تسجيل فريق جديد' },
  subscription_activated: { type: 'subscription_changed', title: 'تفعيل اشتراك' },
  subscription_moved_to_grace: { type: 'subscription_changed', title: 'انتقال اشتراك إلى فترة السماح' },
  plan_changed: { type: 'subscription_changed', title: 'تغيير خطة فريق' },
  trial_extended: { type: 'subscription_changed', title: 'تمديد فترة تجربة' },
  trial_ended: { type: 'subscription_changed', title: 'انتهاء فترة تجربة' },
  customer_demo_session_started: { type: 'demo_started', title: 'بدأت تجربة عميل جديدة', description: 'تجربة بسيطة' },
  customer_demo_session_expired: { type: 'demo_expired', title: 'انتهت تجربة عميل', description: 'انتهت مدة التجربة' },
};

const activityRow = (event) => {
  const map = ACTIVITY_OF[event.action];
  const tenantName = event.tenant && event.tenant.displayName;
  return {
    id: String(event._id),
    type: map.type,
    title: map.title,
    description: map.description || (tenantName ? `«${tenantName}»` : 'فريق على المنصة'),
    occurredAt: iso(event.occurredAt),
  };
};

const recentActivity = async (limit = 10) => {
  const events = await AuditEvent.find({ stream: 'platform', action: { $in: Object.keys(ACTIVITY_OF) } })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit)
    .select('action occurredAt tenant')
    .lean();
  return events.map(activityRow);
};

const countOf = (rows, key) => (rows.find((r) => r._id === key) || {}).count || 0;

const HEALTH_SEVERITY = { unavailable: 'critical', degraded: 'warning' };

const buildAttention = async ({ now, tenantFacet, signals, alerts }) => {
  const items = [];

  // One item per tenant awaiting final deletion.
  tenantFacet.deletionPending.forEach((t) => {
    const deletion = (t.lifecycle && t.lifecycle.deletion) || {};
    const item = {
      id: `attention_deletion_${t._id}`,
      severity: 'warning',
      category: 'tenant_lifecycle',
      title: 'فريق بانتظار الحذف النهائي',
      description: `«${t.displayName}» مجدول للحذف النهائي.`,
      occurredAt: iso(deletion.requestedAt || t.updatedAt || now),
      target: 'tenants',
      tenantId: String(t._id),
    };
    if (deletion.scheduledFor) item.scheduledFor = iso(deletion.scheduledFor);
    items.push(item);
  });

  const grace = countOf(tenantFacet.subscription, 'grace');
  if (grace > 0) {
    items.push({
      id: 'attention_grace',
      severity: 'warning',
      category: 'subscription',
      title: `${arCount(grace, SUBSCRIPTIONS)} في فترة السماح`,
      description: 'يحتاج إلى متابعة قبل انتهاء فترة السماح.',
      occurredAt: iso(now),
      target: 'tenants',
    });
  }

  const trials = tenantFacet.trialsEnding[0] ? tenantFacet.trialsEnding[0].n : 0;
  if (trials > 0) {
    items.push({
      id: 'attention_trials_ending',
      severity: 'info',
      category: 'trial',
      title: trials === 1 ? 'فترة تجربة تنتهي قريبًا' : 'فترات تجربة تنتهي قريبًا',
      description: `عدد فترات التجربة التي تنتهي خلال 3 أيام: ${trials}.`,
      occurredAt: iso(now),
      target: 'tenants',
    });
  }

  alerts
    .filter((a) => a.severity === 'critical')
    .forEach((a) =>
      items.push({
        id: `attention_${a.id}`,
        severity: 'critical',
        category: 'security',
        title: a.title,
        description: a.description,
        occurredAt: a.detectedAt,
        target: 'security',
      }),
    );

  signals
    .filter((s) => HEALTH_SEVERITY[s.status])
    .forEach((s) =>
      items.push({
        id: `attention_health_${s.id}`,
        severity: HEALTH_SEVERITY[s.status],
        category: 'health',
        title: s.label,
        description: s.summary,
        occurredAt: s.observedAt,
        target: 'health',
      }),
    );

  const defs = safeDefinitions();
  const failed = defs.length ? await JobRun.find({ _id: { $in: defs.map((d) => d.name) }, lastStatus: 'failed' }).lean() : [];
  failed
    .sort((a, b) => a._id.localeCompare(b._id))
    .forEach((r) =>
      items.push({
        id: `attention_job_${r._id}`,
        severity: 'warning',
        category: 'background_job',
        title: 'تعذّر إكمال مهمة خلفية',
        description: `فشل آخر تشغيل للمهمة «${r._id}».`,
        occurredAt: iso(r.lastRunAt || now),
        target: 'operations',
      }),
    );

  items.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  return items;
};

/**
 * GET /platform/overview. See docs/api/platform-insights.md for the exact
 * definition of every number.
 */
const overview = async (now = new Date()) => {
  const [[tenantFacet], demoFacet, signals, alerts, activity] = await Promise.all([
    SaasTenant.aggregate([
      { $match: NOT_DELETED },
      {
        $facet: {
          total: [{ $count: 'n' }],
          subscription: [{ $group: { _id: '$subscription.status', count: { $sum: 1 } } }],
          lifecycle: [{ $group: { _id: '$lifecycle.status', count: { $sum: 1 } } }],
          deletionPending: [
            { $match: { 'lifecycle.status': 'deletion_pending' } },
            { $sort: { 'lifecycle.deletion.scheduledFor': 1, _id: 1 } },
            { $project: { displayName: 1, lifecycle: 1, updatedAt: 1 } },
          ],
          trialsEnding: [
            { $match: { 'subscription.status': 'trial', 'subscription.trialEndsAt': { $gt: now, $lte: new Date(now.getTime() + 3 * DAY) } } },
            { $count: 'n' },
          ],
          storage: [
            {
              $group: {
                _id: null,
                used: { $sum: { $ifNull: ['$usage.storageUsedBytes', 0] } },
                allowance: { $sum: { $ifNull: ['$usage.storageAllowanceBytes', 0] } },
              },
            },
          ],
        },
      },
    ]),
    DemoSession.aggregate([
      { $match: { status: 'active', expiresAt: { $gt: now } } },
      {
        $group: {
          _id: null,
          active: { $sum: 1 },
          expiringSoon: { $sum: { $cond: [{ $lte: ['$expiresAt', new Date(now.getTime() + DAY)] }, 1, 0] } },
        },
      },
    ]),
    healthSignals(now),
    securityAlerts(now),
    recentActivity(10),
  ]);

  const total = tenantFacet.total[0] ? tenantFacet.total[0].n : 0;
  const demos = demoFacet[0] || { active: 0, expiringSoon: 0 };
  const body = {
    generatedAt: iso(now),
    tenants: {
      total,
      activeSubscriptions: countOf(tenantFacet.subscription, 'active'),
      activeTrials: countOf(tenantFacet.subscription, 'trial'),
      gracePeriod: countOf(tenantFacet.subscription, 'grace'),
      suspended: countOf(tenantFacet.lifecycle, 'suspended'),
      deletionPending: countOf(tenantFacet.lifecycle, 'deletion_pending'),
    },
    // Point 18B: no demo kinds exist yet — every active demo is `simple`.
    demos: { active: demos.active, simple: demos.active, full: 0, expiringSoon: demos.expiringSoon },
    health: signals,
    attention: await buildAttention({ now, tenantFacet, signals, alerts }),
    recentActivity: activity,
  };
  if (total > 0) {
    const storage = tenantFacet.storage[0] || { used: 0, allowance: 0 };
    body.usage = { storageUsedBytes: storage.used, storageAllowanceBytes: storage.allowance };
  }
  return body;
};

// ---- Audit ------------------------------------------------------------------------------------

/** AuditEvent JSON without an empty target shell. */
const serializeAudit = (doc) => {
  const json = doc.toJSON();
  if (json.target && !json.target.type && !json.target.id) delete json.target;
  return json;
};

const decodeAuditCursor = (raw) => {
  const c = cursorUtil.decode(raw);
  if (!c) return null;
  const at = c.at ? new Date(c.at) : null;
  if (!at || Number.isNaN(at.getTime()) || typeof c.id !== 'string' || !c.id) {
    throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
  }
  return { at, id: c.id };
};

/**
 * GET /platform/audit — platform stream only. Filters apply BEFORE paging;
 * order is occurredAt desc, _id desc (total and stable).
 */
const listAudit = async (q) => {
  if (q.from && q.before && q.from >= q.before) {
    throw AppError.validation({ before: 'before must be later than from.' });
  }
  const and = [{ stream: 'platform' }];
  if (q.from || q.before) {
    const occurredAt = {};
    if (q.from) occurredAt.$gte = q.from;
    if (q.before) occurredAt.$lt = q.before;
    and.push({ occurredAt });
  }
  if (q.actorKind) and.push({ 'actor.kind': q.actorKind });
  if (q.actorId) and.push({ 'actor.id': q.actorId });
  if (q.action) and.push({ action: q.action });
  if (q.category) and.push({ category: q.category });
  if (q.tenantId) and.push({ 'tenant.id': q.tenantId });
  if (q.targetType) and.push({ 'target.type': q.targetType });
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    and.push({
      $or: [{ _id: rx }, { 'actor.displayName': rx }, { 'target.id': rx }, { 'target.displayName': rx }, { 'tenant.id': rx }, { 'tenant.displayName': rx }],
    });
  }
  const after = decodeAuditCursor(q.cursor);
  if (after) {
    and.push({ $or: [{ occurredAt: { $lt: after.at } }, { occurredAt: after.at, _id: { $lt: after.id } }] });
  }

  const limit = q.limit || 50;
  const docs = await AuditEvent.find({ $and: and }).sort({ occurredAt: -1, _id: -1 }).limit(limit + 1);
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(serializeAudit),
    nextCursor: docs.length > limit && last ? cursorUtil.encode({ at: last.occurredAt.toISOString(), id: String(last._id) }) : null,
  };
};

const getAuditEvent = async (eventId) => {
  const doc = await AuditEvent.findOne({ _id: eventId, stream: 'platform' });
  if (!doc) throw AppError.notFound('audit event');
  return serializeAudit(doc);
};

module.exports = {
  arCount,
  health,
  healthSignals,
  securityAlerts,
  securityAlertsSnapshot,
  overview,
  recentActivity,
  listAudit,
  getAuditEvent,
  serializeAudit,
  listJobs,
  runAllJobs,
  runOneJob,
  ACTIVITY_OF,
};
