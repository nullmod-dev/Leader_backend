/**
 * /platform/tenants — the Super Admin subscriber list, registration, detail
 * and compact status history (screens: /platform/tenants, tenant detail).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const cursor = require('../../utils/cursor');
const { searchFold, normalizeTeamCode } = require('../../utils/normalize');
const { SaasTenant, TenantStatusEvent, TenantTombstone } = require('../../models');
const { withTransaction } = require('../../services/txn');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const { provisionSeatAccount } = require('../../services/authorizationService');
const lifecycleService = require('../../services/tenantLifecycleService');
const view = require('../../services/tenantView');

const DAY_MS = lifecycleService.DAY_MS;

const compact = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Does the tenant match the folded search needle (name, Main Admin name/email, Team Code)? */
const matcher = (search) => {
  const needle = searchFold(search || '');
  if (!needle) return () => true;
  const canonical = normalizeTeamCode(search);
  const code = compact(needle);
  return (tenant, admin) => {
    if (canonical && tenant.teamCode === canonical) return true;
    const keys = [tenant.displayName, admin ? admin.name : '', admin ? admin.email : '', tenant.teamCode].map((k) => searchFold(k));
    if (keys.some((k) => k.includes(needle))) return true;
    return code.length >= 4 && compact(tenant.teamCode).includes(code);
  };
};

/** GET /platform/tenants?search&status&cursor&limit */
exports.list = catchAsync(async (req, res) => {
  const { search, status, limit } = req.query;
  const position = cursor.decode(req.query.cursor);
  const offset = position ? position.o : 0;
  if (!Number.isInteger(offset) || offset < 0) throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');

  // Tenant counts are small: filter in memory, BEFORE paging, in a stable total order.
  const tenants = await SaasTenant.find({}).sort({ createdAt: -1, _id: -1 });
  const admins = await view.mainAdminsFor(tenants);
  const matches = matcher(search);
  const filtered = tenants.filter((t) => {
    if (status && t.listStatus() !== status) return false;
    return matches(t, admins.get(String(t.seat && t.seat.currentAccountId)));
  });

  const page = filtered.slice(offset, offset + limit);
  const counts = await view.countsFor(page.map((t) => t._id));
  const items = page.map((t) =>
    view.serializeTenant(t, {
      mainAdminAccount: admins.get(String(t.seat && t.seat.currentAccountId)) || null,
      counts: counts.get(String(t._id)),
    }),
  );
  const next = offset + limit < filtered.length ? cursor.encode({ o: offset + limit }) : null;
  res.json({ items, total: filtered.length, nextCursor: next });
});

/** GET /platform/tenants/suggest-team-code */
exports.suggestTeamCode = catchAsync(async (req, res) => {
  res.json({ teamCode: await lifecycleService.suggestTeamCode() });
});

const mapDuplicate = (err) => {
  if (!err || err.code !== 11000) return err;
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  if (keys.includes('teamCode')) {
    return new AppError('tenant_code_conflict', 409, 'This Team Code is not available.', { fields: { teamCode: 'This Team Code is not available.' } });
  }
  if (keys.includes('email')) return new AppError('main_admin_identity_unavailable', 409, 'This address cannot be designated.');
  return err;
};

/** POST /platform/tenants (idem) — register a subscriber + its initial Main Admin seat. */
exports.create = catchAsync(async (req, res) => {
  const actor = req.auth.account;
  const { displayName, mainAdminName, mainAdminEmail } = req.body;
  const settings = await settingsService.get();
  const timezone = req.body.timezone || settings.defaultTimezone;

  let tenant;
  try {
    tenant = await withTransaction(async (session) => {
      const now = new Date();
      let teamCode = req.body.teamCode || null;
      if (teamCode) await lifecycleService.assertTeamCodeAvailable(teamCode, { session });
      else teamCode = await lifecycleService.suggestTeamCode({ session });

      const [created] = await SaasTenant.create(
        [
          {
            displayName,
            teamCode,
            timezone,
            lifecycle: { status: 'active', version: 1 },
            subscription: {
              status: 'trial',
              planId: null,
              version: 1,
              trialEndsAt: new Date(now.getTime() + settings.trialDays * DAY_MS),
              renewsAt: null,
              graceEndsAt: null,
            },
          },
        ],
        { session },
      );
      const { account } = await provisionSeatAccount({
        tenant: created,
        name: mainAdminName,
        email: mainAdminEmail,
        kind: 'initial_seat',
        createdBy: actor,
        session,
      });
      created.seat.currentAccountId = String(account._id);
      await created.save({ session });

      await lifecycleService.recordEvent(created._id, 'tenant_created', null, { session, occurredAt: now });
      await lifecycleService.recordEvent(created._id, 'trial_started', null, { session, occurredAt: now });
      await auditService.record({
        action: 'tenant_registered',
        actor,
        target: { type: 'tenant', id: String(created._id), displayName: created.displayName },
        tenant: created,
        changes: [
          { field: 'lifecycle_status', after: 'active' },
          { field: 'subscription_status', after: 'trial' },
        ],
        session,
      });
      return created;
    });
  } catch (err) {
    throw mapDuplicate(err);
  }

  res.status(201).json(await view.tenantPayload(tenant));
});

/** GET /platform/tenants/:tenantId — the live record, or the tombstone after final deletion. */
exports.get = catchAsync(async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await SaasTenant.findById(tenantId);
  if (tenant) return res.json(await view.tenantPayload(tenant));
  const tombstone = await TenantTombstone.findById(tenantId);
  if (tombstone) return res.json(tombstone.toJSON());
  throw AppError.notFound('tenant');
});

/** GET /platform/tenants/:tenantId/status-history — newest first; still readable for a tombstone. */
exports.statusHistory = catchAsync(async (req, res) => {
  const { tenantId } = req.params;
  const exists = (await SaasTenant.exists({ _id: tenantId })) || (await TenantTombstone.exists({ _id: tenantId }));
  if (!exists) throw AppError.notFound('tenant');
  const events = await TenantStatusEvent.find({ tenantId }).sort({ occurredAt: -1, _id: -1 });
  res.json(events.map(view.serializeStatusEvent));
});
