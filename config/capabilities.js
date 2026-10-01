/**
 * The 30-key capability catalogue (CAPABILITIES.md, lib/core/access/capability.dart).
 *
 * A grant is `{ global: string[], scoped: { [detachmentId]: string[] } }`.
 * `canIn` = key is known AND (global has it OR that detachment's set has it),
 * and any non-empty scoped entry implies `detachment.view` for that detachment.
 * Unknown keys never grant anything.
 */

const GLOBAL_CAPS = [
  'detachment.create',
  'workshop.create',
  'workshop.edit',
  'workshop.archive',
  'workshop.people.manage',
  'workshop.attendance.record',
  'workshop.payment.record',
  'workshop.section.manage',
  'admin.manage',
  'org.edit',
];

const SCOPED_CAPS = [
  'detachment.view',
  'detachment.edit',
  'detachment.archive',
  'member.view',
  'member.contact.view',
  'member.invite',
  'member.edit',
  'member.deactivate',
  'member.role.assign',
  'shift.manage',
  'shift.delete',
  'shift.assign',
  'shift.publish',
  'shift.attendance.record',
  'shift.attendance.override',
  'shift.occurrence.manage',
  'inventory.adjust',
  'inventory.item.manage',
  'stats.view',
  'announcement.publish',
];

const ALL_CAPS = [...GLOBAL_CAPS, ...SCOPED_CAPS];
const ALL_SET = new Set(ALL_CAPS);

/** Sub-admin preset: every operational act, no lifecycle, no money, no administration. */
const SUB_ADMIN_PRESET = [
  'detachment.view',
  'member.view',
  'member.contact.view',
  'member.invite',
  'member.edit',
  'member.role.assign',
  'shift.manage',
  'shift.assign',
  'shift.publish',
  'shift.attendance.record',
  'shift.occurrence.manage',
  'inventory.adjust',
  'inventory.item.manage',
  'workshop.create',
  'workshop.edit',
  'workshop.people.manage',
  'workshop.attendance.record',
  'workshop.section.manage',
  'stats.view',
];

/** Keys a Main Admin may put in a Simple Admin invitation (simple_admin_models.dart). */
const SIMPLE_ADMIN_ASSIGNABLE = [...SUB_ADMIN_PRESET, 'announcement.publish'];

/** Which tenant module a capability belongs to — a key for a disabled module is not assignable. */
const CAP_FEATURE = {
  'inventory.adjust': 'inventory',
  'inventory.item.manage': 'inventory',
  'workshop.create': 'workshops',
  'workshop.edit': 'workshops',
  'workshop.archive': 'workshops',
  'workshop.people.manage': 'workshops',
  'workshop.attendance.record': 'workshops',
  'workshop.payment.record': 'workshops',
  'workshop.section.manage': 'workshops',
  'stats.view': 'statistics_reports',
  'announcement.publish': 'announcements',
};

const emptyGrant = () => ({ global: [], scoped: {} });

/** The Main Admin grant: the full catalogue, held globally. */
const mainAdminGrant = () => ({ global: [...ALL_CAPS], scoped: {} });

/**
 * Build a grant from a flat key list. Global keys go to `global`; scoped keys
 * go to every listed detachment, or to `global` when no detachment is listed.
 */
const grantFromKeys = (keys = [], detachmentIds = []) => {
  const unique = [...new Set(keys)].filter((k) => ALL_SET.has(k));
  const global = unique.filter((k) => GLOBAL_CAPS.includes(k));
  const scopedKeys = unique.filter((k) => SCOPED_CAPS.includes(k));
  if (!detachmentIds.length) return { global: [...global, ...scopedKeys], scoped: {} };
  const scoped = {};
  detachmentIds.forEach((id) => {
    scoped[id] = [...scopedKeys];
  });
  return { global, scoped };
};

const normalizeGrant = (grant) => {
  const g = grant || {};
  const scopedIn = g.scoped instanceof Map ? Object.fromEntries(g.scoped) : g.scoped || {};
  const scoped = {};
  Object.entries(scopedIn).forEach(([detId, keys]) => {
    const list = [...new Set(keys || [])];
    if (list.length) scoped[detId] = list;
  });
  return { global: [...new Set(g.global || [])], scoped };
};

const can = (grant, key) => ALL_SET.has(key) && normalizeGrant(grant).global.includes(key);

const canIn = (grant, detachmentId, key) => {
  if (!ALL_SET.has(key)) return false;
  const g = normalizeGrant(grant);
  if (g.global.includes(key)) return true;
  const set = detachmentId ? g.scoped[detachmentId] : undefined;
  if (!set || !set.length) return false;
  if (set.includes(key)) return true;
  return key === 'detachment.view';
};

const canAnyIn = (grant, detachmentId, keys) => keys.some((k) => canIn(grant, detachmentId, k));

/** True if the key is held globally or in ANY detachment. */
const canAnywhere = (grant, key) => {
  if (!ALL_SET.has(key)) return false;
  const g = normalizeGrant(grant);
  if (g.global.includes(key)) return true;
  return Object.values(g.scoped).some((set) => set.includes(key) || (key === 'detachment.view' && set.length > 0));
};

/**
 * Detachments this grant can see. `null` = every detachment of the tenant
 * (global `detachment.view`); otherwise the explicit id list.
 */
const visibleDetachmentIds = (grant) => {
  const g = normalizeGrant(grant);
  if (g.global.includes('detachment.view')) return null;
  return Object.keys(g.scoped).filter((id) => g.scoped[id].length > 0);
};

/** Detachments in which the grant holds `key` (null = all). */
const detachmentsWith = (grant, key) => {
  const g = normalizeGrant(grant);
  if (g.global.includes(key)) return null;
  return Object.keys(g.scoped).filter((id) => canIn(g, id, key));
};

const hasAny = (grant) => {
  const g = normalizeGrant(grant);
  return g.global.length > 0 || Object.keys(g.scoped).length > 0;
};

const unknownKeys = (keys = []) => keys.filter((k) => !ALL_SET.has(k));

module.exports = {
  GLOBAL_CAPS,
  SCOPED_CAPS,
  ALL_CAPS,
  SUB_ADMIN_PRESET,
  SIMPLE_ADMIN_ASSIGNABLE,
  CAP_FEATURE,
  emptyGrant,
  mainAdminGrant,
  grantFromKeys,
  normalizeGrant,
  can,
  canIn,
  canAnyIn,
  canAnywhere,
  visibleDetachmentIds,
  detachmentsWith,
  hasAny,
  unknownKeys,
};
