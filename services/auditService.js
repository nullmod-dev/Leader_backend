/**
 * The ONLY writer of AuditEvent. Flutter appends nothing; no endpoint edits or
 * deletes an event.
 *
 * Changes are TYPED FIELDS, never object snapshots. A field outside the
 * allow-list, or a value of the wrong kind, is stored as `{kind:"redacted"}`.
 * `login_identity` is ALWAYS redacted. Passwords, OTPs, tokens, Team Codes,
 * reasons and request bodies never reach an event.
 */
const { AuditEvent } = require('../models');

/** action → category (the client derives category from action, never trusts a second truth). */
const ACTION_CATEGORY = {
  tenant_registered: 'tenant_management',
  subscription_activated: 'subscription',
  trial_extended: 'subscription',
  trial_ended: 'subscription',
  subscription_moved_to_grace: 'subscription',
  plan_changed: 'subscription',
  limit_override_changed: 'entitlement',
  feature_flag_changed: 'entitlement',
  tenant_suspended: 'lifecycle',
  tenant_reactivated: 'lifecycle',
  deletion_requested: 'lifecycle',
  deletion_cancelled: 'lifecycle',
  deletion_finalized: 'lifecycle',
  break_glass_activated: 'emergency_access',
  break_glass_ended: 'emergency_access',
  break_glass_expired: 'emergency_access',
  break_glass_revoked: 'emergency_access',
  main_admin_setup_resent: 'account_management',
  main_admin_suspended: 'account_management',
  main_admin_reactivated: 'account_management',
  main_admin_replacement_started: 'account_management',
  main_admin_replacement_cancelled: 'account_management',
  main_admin_replaced: 'account_management',
  main_admin_setup_completed: 'account_management',
  customer_demo_policy_changed: 'customer_demo',
  customer_demo_session_started: 'customer_demo',
  customer_demo_session_terminated: 'customer_demo',
  customer_demo_session_expired: 'customer_demo',
  // commerce (Point 19)
  commerce_offer_created: 'commerce',
  commerce_offer_updated: 'commerce',
  commerce_offer_enabled: 'commerce',
  commerce_offer_disabled: 'commerce',
  commerce_offer_removed: 'commerce',
  commerce_coupon_created: 'commerce',
  commerce_coupon_updated: 'commerce',
  commerce_coupon_enabled: 'commerce',
  commerce_coupon_disabled: 'commerce',
  commerce_coupon_removed: 'commerce',
  commerce_coupon_redeemed: 'commerce',
  billing_order_paid: 'commerce',
  billing_order_cancelled: 'commerce',
  // platform settings & accounts
  platform_settings_changed: 'platform_configuration',
  plan_created: 'platform_configuration',
  plan_updated: 'platform_configuration',
  plan_deleted: 'platform_configuration',
  account_sessions_revoked: 'account_management',
  platform_admin_created: 'account_management',
  platform_admin_suspended: 'account_management',
  platform_admin_reactivated: 'account_management',
  // tenant-scoped stream (Simple Admin management)
  admin_invitation_created: 'admin_management',
  admin_invitation_cancelled: 'admin_management',
  admin_invitation_accepted: 'admin_management',
  admin_capabilities_changed: 'admin_management',
  admin_suspended: 'admin_management',
  admin_reactivated: 'admin_management',
};

/** Allowed change fields and the value kind each may carry. */
const FIELD_KINDS = {
  lifecycle_status: 'text',
  subscription_status: 'text',
  plan_assignment: 'text',
  feature_enabled: 'bool',
  limit_override: 'integer',
  account_status: 'text',
  login_identity: 'redacted',
  demo_availability: 'bool',
  demo_default_duration: 'integer', // integer MINUTES
  termination_reason: 'text', // user_ended | super_admin_terminated | terminate_all
  invitation_status: 'text',
  capability_grant: 'text', // comma-joined key list
  offer_enabled: 'bool',
  coupon_enabled: 'bool',
  billing_order_status: 'text',
  setting_value: 'text',
};

const REDACTED = { kind: 'redacted' };

const typedValue = (field, value) => {
  if (value === undefined) return undefined;
  const kind = FIELD_KINDS[field];
  if (!kind || kind === 'redacted') return REDACTED;
  if (value === null) return undefined;
  if (kind === 'bool') return typeof value === 'boolean' ? { kind, value } : REDACTED;
  if (kind === 'integer') return Number.isInteger(value) ? { kind, value } : REDACTED;
  if (kind === 'text') {
    if (Array.isArray(value)) return { kind, value: value.join(',') };
    return typeof value === 'string' || typeof value === 'number' ? { kind, value: String(value) } : REDACTED;
  }
  return REDACTED;
};

const sanitizeChanges = (changes = []) =>
  changes.map((c) => {
    const field = FIELD_KINDS[c.field] ? c.field : 'redacted_field';
    const out = { field };
    const before = typedValue(c.field, c.before);
    const after = typedValue(c.field, c.after);
    if (before !== undefined) out.before = before;
    if (after !== undefined) out.after = after;
    return out;
  });

const SYSTEM = { kind: 'system' };

/** Actor snapshot from an Account (id + display name only — never email/session). */
const actorOf = (account) => {
  if (!account) return SYSTEM;
  const kind = account.role === 'super_admin' ? 'platform_administrator' : 'tenant_administrator';
  return { kind, id: String(account._id), displayName: account.name || '' };
};

const tenantRef = (tenant) =>
  tenant ? { id: String(tenant._id || tenant.id), displayName: tenant.displayName || tenant.displayNameSnapshot || '', isDeleted: !!tenant.isDeleted } : undefined;

/**
 * Append one event.
 * @param {object} p
 * @param {string} p.action    catalogue action
 * @param {object} [p.actor]   Account doc, or omit/null for `system`
 * @param {object} [p.target]  { type, id, displayName? }
 * @param {object} [p.tenant]  SaasTenant doc or { id, displayName, isDeleted }
 * @param {Array}  [p.changes] [{ field, before, after }]
 * @param {'platform'|'tenant'} [p.stream]
 * @param {object} [p.session] mongoose session
 */
const record = async ({ action, actor, target, tenant, changes, stream = 'platform', grantId, session, occurredAt }) => {
  const category = ACTION_CATEGORY[action] || 'unknown';
  const t = tenantRef(tenant);
  const [event] = await AuditEvent.create(
    [
      {
        stream,
        occurredAt: occurredAt || new Date(),
        actor: actor && actor.kind ? actor : actorOf(actor),
        action,
        category,
        target: target || undefined,
        tenant: t,
        changes: sanitizeChanges(changes),
        grantId,
        tenantScopeId: stream === 'tenant' && t ? t.id : undefined,
      },
    ],
    { session },
  );
  return event;
};

module.exports = { record, actorOf, ACTION_CATEGORY, FIELD_KINDS, SYSTEM, sanitizeChanges };
