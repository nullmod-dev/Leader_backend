/**
 * The device-trust restriction, enforced on the server.
 *
 * A session is restricted while its device is new (the first
 * NEW_DEVICE_RESTRICT_HOURS after its email code, unless a trusted device
 * answered "Yes") or untrusted (no free trusted slot). `req.auth.restriction`
 * is set by middlewares/auth.authenticate; this module refuses, with
 * 403 session_restricted { reason, restrictedUntil? }:
 *
 *  1. `assertAllowed` — called by authenticate on EVERY authenticated request:
 *     the account-level actions in DENY (password, MFA, other sessions and
 *     devices, administrators and their roles, the organisation, billing,
 *     the workshop export, every platform write).
 *  2. `assertOwnRecord` — called by loadTenantDoc for every write that
 *     targets one tenant record: allowed only when THIS device created the
 *     record (models/plugins/base.js stamps `_createdByDevice`), or when the
 *     route is in OLD_RECORD_ACTIONS (field work on older records: attendance
 *     check-in/out/absent, inventory movements, shift-assignment adds, and
 *     adding people to a workshop).
 *
 * Creating records is allowed (no loadTenantDoc on a collection POST, and a
 * parent loaded by `router.use` — e.g. the detachment a new shift goes into —
 * has no `req.route` and is not the write's target). Reads are allowed,
 * except the export in DENY. Sync push replays each operation through this
 * API with the same bearer, so both checks cover it.
 *
 * A NEW write route is allowed by default unless it targets a record through
 * loadTenantDoc or is added to DENY.
 */
const AppError = require('../utils/appError');

const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];
const isWrite = (method) => WRITE.includes(method);

/** Refused while restricted: [methods, path under /api/v1]. */
const DENY = [
  [['POST'], /^\/auth\/me\/password$/],
  [['POST'], /^\/auth\/mfa\/(setup|disable)$/],
  [['DELETE'], /^\/auth\/sessions(\/[^/]+)?$/],
  [['POST'], /^\/auth\/devices\/[^/]+\/(approve|deny)$/],
  [['DELETE'], /^\/auth\/devices\/[^/]+$/],
  [WRITE, /^\/tenant\/simple-admin/],
  [WRITE, /^\/settings\/organization(\/|$)/],
  [WRITE, /^\/billing\//],
  [['GET'], /^\/workshops\/[^/]+\/export\.csv$/],
  [WRITE, /^\/platform\//],
];

/** Allowed on records this device did not create: `METHOD collection route`. */
const OLD_RECORD_ACTIONS = new Set([
  'POST shifts /:shiftId/members/:memberId/check-in',
  'POST shifts /:shiftId/members/:memberId/check-out',
  'POST shifts /:shiftId/members/:memberId/absent',
  'POST shifts /:shiftId/assignments',
  'POST inventory-items /:itemId/movements',
  'POST workshops /:workshopId/team-members',
  'POST workshops /:workshopId/guests',
  'POST workshops /:workshopId/participants',
  'POST workshops /:workshopId/organizers',
]);

const restricted = (restriction) =>
  new AppError('session_restricted', 403, 'This action is locked on a new device for now.', {
    reason: restriction.reason,
    ...(restriction.until ? { restrictedUntil: restriction.until.toISOString() } : {}),
  });

const pathOf = (req) => String(req.originalUrl || req.url || '').split('?')[0].replace(/^\/api\/v1/, '');

const assertAllowed = (req) => {
  const restriction = req.auth && req.auth.restriction;
  if (!restriction) return;
  const path = pathOf(req);
  if (DENY.some(([methods, re]) => methods.includes(req.method) && re.test(path))) throw restricted(restriction);
};

const assertOwnRecord = (req, doc) => {
  const restriction = req.auth && req.auth.restriction;
  if (!restriction || !isWrite(req.method) || !req.route) return;
  const collection = String(req.baseUrl || '').split('/').pop();
  if (OLD_RECORD_ACTIONS.has(`${req.method} ${collection} ${req.route.path}`)) return;
  const device = req.auth.device;
  if (device && doc._createdByDevice && doc._createdByDevice === String(device._id)) return;
  throw restricted(restriction);
};

module.exports = { assertAllowed, assertOwnRecord, DENY, OLD_RECORD_ACTIONS };
