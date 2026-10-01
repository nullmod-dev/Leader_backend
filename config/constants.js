/**
 * Closed wire vocabularies. Every string here is parsed by the Flutter client
 * (see docs/FRONTEND-INTEGRATION-GUIDE.md §Vocabularies). Never rename a value
 * without a contract change — an unknown value makes the client fail closed.
 */

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  MAIN_ADMIN: 'main_admin',
  ADMIN: 'admin',
  CUSTOMER_DEMO: 'customer_demo',
});
const TENANT_ROLES = [ROLES.MAIN_ADMIN, ROLES.ADMIN];

const ACCOUNT_STATUS = ['active', 'suspended', 'revoked', 'pending_setup'];
const TENANT_STATUS = ['active', 'suspended', 'deletion_pending', 'deleted'];
const DEMO_MODE = ['none', 'active', 'expired'];

const LINK_STATUS = ['unlinked', 'linked', 'withdrawn'];
const SETUP_STATUS = ['required', 'completed'];
const AUTH_METHODS = ['password', 'google'];

const SUBSCRIPTION_STATUS = ['trial', 'active', 'grace', 'inactive'];
const PLAN_LIMIT_KEYS = ['detachment_groups', 'detachments', 'admins', 'members', 'workshops', 'storage_bytes'];
const FEATURE_KEYS = ['inventory', 'statistics_reports', 'workshops', 'announcements'];
const DEFAULT_ENABLED_FEATURES = ['inventory', 'announcements'];

const TENANT_EVENT_TYPES = [
  'tenant_created',
  'trial_started',
  'trial_ended',
  'trial_extended',
  'subscription_activated',
  'moved_to_grace',
  'plan_changed',
  'limit_override_changed',
  'tenant_suspended',
  'tenant_reactivated',
  'deletion_requested',
  'deletion_cancelled',
  'tenant_deleted',
];

// ---- tenant operational vocabularies (as the Dart code WRITES them) --------
const TEAM_ROLES = ['shiftSupervisor', 'administrator', 'followUp', 'member'];
// Legacy values the Flutter reader still accepts; the server accepts them on
// input and always writes the new vocabulary.
const LEGACY_TEAM_ROLE = { lead: 'shiftSupervisor', medic: 'administrator', trainee: 'followUp', volunteer: 'member' };

const ATTENDANCE_STATES = ['notCheckedIn', 'checkedIn', 'checkedOut', 'absent'];
const LEGACY_ATTENDANCE = { present: 'checkedIn', late: 'checkedIn', notInvited: 'notCheckedIn' };

const RECORD_STATUS = ['active', 'archived'];

const INVENTORY_LEVELS = ['ok', 'low', 'empty'];
const PACKAGING_UNITS = ['individual', 'strip', 'carton'];
const MOVEMENT_DIRECTIONS = ['inflow', 'outflow'];
const STORAGE_STATUS = ['empty', 'healthy', 'expiring', 'low', 'depleted'];
const EXPIRING_SOON_DAYS = 30;

const WORKSHOP_STATUS = ['scheduled', 'ongoing', 'done'];
const PARTICIPANT_KINDS = ['member', 'guest'];
const WORKSHOP_ROLES = ['leader', 'trainer', 'support', 'management', 'member'];
const PAYMENT_STATUS = ['paid', 'unpaid'];

const ANNOUNCEMENT_PLACEMENTS = ['notifications', 'home', 'detachment'];
const ANNOUNCEMENT_STATUS = ['active', 'withdrawn'];
const ANNOUNCEMENT_TEXT_MIN = 5;
const ANNOUNCEMENT_TEXT_MAX = 500;

const NOTIFICATION_KINDS = [
  'shiftUnderstaffed',
  'shiftAttendanceMissing',
  'shiftStartingSoon',
  'stockDepleted',
  'stockLow',
  'stockExpiring',
  'announcement',
];

// ---- control plane --------------------------------------------------------
const MAIN_ADMIN_ACCOUNT_STATUS = ['pending_setup', 'active', 'suspended'];
const BREAK_GLASS_STATUS = ['active', 'expired', 'ended'];
const BREAK_GLASS_END_REASONS = ['ended_by_initiator', 'session_ended', 'tenant_unavailable', 'revoked_by_platform'];
const BREAK_GLASS_SCOPES = ['tenant_operational_read'];

const DEMO_SESSION_STATUS = ['active', 'expired', 'terminated'];
const DEMO_TERMINATION_REASONS = ['user_ended', 'super_admin_terminated', 'terminate_all'];

const BILLING_OPTIONS = [
  { id: 'monthly', months: 1, basePrice: 600 },
  { id: 'three_months', months: 3, basePrice: 1400 },
  { id: 'six_months', months: 6, basePrice: 2400 },
  { id: 'twelve_months', months: 12, basePrice: 4000 },
];
const PROMOTION_ELIGIBLE_OPTIONS = ['monthly', 'three_months'];
const CURRENCY = 'USD';

const REASON_MAX = 280;
const DISPLAY_NAME_MAX = 80;

// Team Code: MTM-XXXX-XXXX over an alphabet without I, O, L, U, 0, 1.
const TEAM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

module.exports = {
  ROLES,
  TENANT_ROLES,
  ACCOUNT_STATUS,
  TENANT_STATUS,
  DEMO_MODE,
  LINK_STATUS,
  SETUP_STATUS,
  AUTH_METHODS,
  SUBSCRIPTION_STATUS,
  PLAN_LIMIT_KEYS,
  FEATURE_KEYS,
  DEFAULT_ENABLED_FEATURES,
  TENANT_EVENT_TYPES,
  TEAM_ROLES,
  LEGACY_TEAM_ROLE,
  ATTENDANCE_STATES,
  LEGACY_ATTENDANCE,
  RECORD_STATUS,
  INVENTORY_LEVELS,
  PACKAGING_UNITS,
  MOVEMENT_DIRECTIONS,
  STORAGE_STATUS,
  EXPIRING_SOON_DAYS,
  WORKSHOP_STATUS,
  PARTICIPANT_KINDS,
  WORKSHOP_ROLES,
  PAYMENT_STATUS,
  ANNOUNCEMENT_PLACEMENTS,
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_TEXT_MIN,
  ANNOUNCEMENT_TEXT_MAX,
  NOTIFICATION_KINDS,
  MAIN_ADMIN_ACCOUNT_STATUS,
  BREAK_GLASS_STATUS,
  BREAK_GLASS_END_REASONS,
  BREAK_GLASS_SCOPES,
  DEMO_SESSION_STATUS,
  DEMO_TERMINATION_REASONS,
  BILLING_OPTIONS,
  PROMOTION_ELIGIBLE_OPTIONS,
  CURRENCY,
  REASON_MAX,
  DISPLAY_NAME_MAX,
  TEAM_CODE_ALPHABET,
};
