/**
 * Device trust.
 *
 * Every sign-in names its installation with `X-Device-Id` (a UUID v4 the app
 * minted on first launch). Before a session opens, `admit` decides:
 *
 *   blocked device                         → 403 device_blocked
 *   trusted device                         → open the session (no code)
 *   anything else, mailbox not proved yet  → the caller asks for an email code
 *   anything else, code just verified:
 *     account has no device at all         → trusted, NOT restricted (first device)
 *     a trusted slot is free               → trusted, restricted for
 *                                            NEW_DEVICE_RESTRICT_HOURS
 *     no free slot                         → untrusted, restricted until a
 *                                            trusted device approves it
 *   A new device on an account that already had one is announced to the
 *   account (`noticePending`, read by its trusted devices through
 *   GET /auth/me) and by email.
 *
 * A restricted session may create records and edit what its own device
 * created; middlewares/restrictedSession.js refuses the rest.
 */
const config = require('../config');
const AppError = require('../utils/appError');
const { sha256 } = require('../utils/ids');
const { Account, Device, Session, SaasTenant } = require('../models');
const emailService = require('./emailService');
const securityService = require('./securityService');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOUR = 3600000;

const hashId = (deviceId) => sha256(`device:${deviceId}`);

/** The request's installation id (lowercase UUID v4), or null. */
const readDeviceId = (req) => {
  const id = req && req.get ? req.get('X-Device-Id') : null;
  return typeof id === 'string' && UUID_V4.test(id) ? id.toLowerCase() : null;
};

const DEVICE_ID_REQUIRED = () =>
  new AppError('device_id_required', 400, 'This app version does not identify its device. Update the app.');
const DEVICE_BLOCKED = () => new AppError('device_blocked', 403, 'This device was blocked for this account.');

const labelOf = (req) => {
  const explicit = req && req.get && req.get('x-device-name');
  if (explicit) return String(explicit).slice(0, 80);
  // Lazy: tokenService requires this module.
  return require('./tokenService').describeDevice(req);
};

const stampNow = (at) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The device this request names for `account`, or null. */
const findFor = async (account, req) => {
  const deviceId = readDeviceId(req);
  if (!deviceId) return null;
  return Device.findOne({ accountId: String(account._id), idHash: hashId(deviceId) });
};

const trustedCount = (accountId) => Device.countDocuments({ accountId: String(accountId), status: 'trusted' });

/** Create or update a device record, tolerating a concurrent insert of the same one. */
const upsert = async (accountId, idHash, fields) => {
  try {
    return await Device.findOneAndUpdate(
      { accountId: String(accountId), idHash },
      { $set: fields, $setOnInsert: { accountId: String(accountId), idHash } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    return Device.findOneAndUpdate({ accountId: String(accountId), idHash }, { $set: fields }, { new: true });
  }
};

/** Mail the account that a new device signed in (no links: the answer is given in the app). */
const announce = async (account, device) => {
  await emailService.sendTemplate(account.email, 'newDeviceSignedIn', { label: device.label, at: stampNow(device.verifiedAt) });
};

/**
 * Decide whether a session may open on the request's device.
 * @returns {Promise<{ device: object|null } | { needsCode: true }>}
 */
const admit = async (account, req, { codeVerified = false } = {}) => {
  // Customer demo identities are throwaway and isolated: no device trust.
  if (account.role === 'customer_demo') return { device: null };
  const deviceId = readDeviceId(req);
  if (!deviceId) throw DEVICE_ID_REQUIRED();
  const accountId = String(account._id);
  const idHash = hashId(deviceId);
  const now = new Date();

  const existing = await Device.findOne({ accountId, idHash });
  if (existing && existing.status === 'blocked') throw DEVICE_BLOCKED();
  if (existing && existing.status === 'trusted') {
    existing.lastSeenAt = now;
    existing.label = labelOf(req);
    await existing.save();
    return { device: existing };
  }
  if (!codeVerified) return { needsCode: true };

  const label = labelOf(req);
  const firstDevice = !existing && !(await Device.exists({ accountId }));
  if (firstDevice) {
    const device = await upsert(accountId, idHash, {
      status: 'trusted',
      label,
      verifiedAt: now,
      approvedAt: now,
      noticePending: false,
      lastSeenAt: now,
    });
    return { device };
  }

  const hasSlot = (await trustedCount(accountId)) < config.trustedDevicesMax;
  const device = await upsert(accountId, idHash, {
    status: hasSlot ? 'trusted' : 'untrusted',
    label,
    verifiedAt: now,
    restrictedUntil: hasSlot ? new Date(now.getTime() + config.newDeviceRestrictHours * HOUR) : null,
    approvedAt: null,
    noticePending: true,
    lastSeenAt: now,
  });
  await announce(account, device);
  return { device };
};

/**
 * Throw device_blocked when the request's device is blocked for `account`;
 * answer whether it is trusted (Google skips the code only on a trusted one).
 */
const isTrusted = async (account, req) => {
  const device = await findFor(account, req);
  if (device && device.status === 'blocked') throw DEVICE_BLOCKED();
  return Boolean(device && device.status === 'trusted');
};

/** Throw device_blocked when the request's device is blocked for `account`. */
const assertNotBlocked = async (account, req) => {
  await isTrusted(account, req);
};

/**
 * The restriction a device puts on its sessions, or null.
 * @returns {null | { reason: 'new_device'|'device_limit', until: Date|null }}
 */
const restrictionOf = (device, now = new Date()) => {
  if (!device) return null;
  if (device.status === 'untrusted') return { reason: 'device_limit', until: null };
  if (device.status === 'trusted' && !device.approvedAt && device.restrictedUntil && device.restrictedUntil > now) {
    return { reason: 'new_device', until: device.restrictedUntil };
  }
  return null;
};

/**
 * A session opened before device trust shipped names its device for the first
 * time: register that phone without a code — trusted while a slot is free,
 * otherwise untrusted (restricted). A blocked one ends the session (401).
 * @returns {Promise<object|null>} the bound device, or null without X-Device-Id
 */
const bindLegacySession = async (account, session, req) => {
  const deviceId = readDeviceId(req);
  if (!deviceId) return null;
  const accountId = String(account._id);
  const idHash = hashId(deviceId);
  const now = new Date();
  let device = await Device.findOne({ accountId, idHash });
  if (!device) {
    const hasSlot = (await trustedCount(accountId)) < config.trustedDevicesMax;
    device = await upsert(accountId, idHash, {
      status: hasSlot ? 'trusted' : 'untrusted',
      label: labelOf(req),
      verifiedAt: now,
      approvedAt: hasSlot ? now : null,
      noticePending: !hasSlot,
      legacy: true,
      lastSeenAt: now,
    });
  }
  if (device.status === 'blocked') {
    await Session.updateOne({ _id: session._id, revokedAt: { $exists: false } }, { $set: { revokedAt: now, revokeReason: 'device_blocked' } });
    throw new AppError('authentication_expired', 401, 'The session has ended. Sign in again.');
  }
  await Session.updateOne({ _id: session._id, deviceRef: { $exists: false } }, { $set: { deviceRef: String(device._id) } });
  session.deviceRef = String(device._id);
  return device;
};

// ---- the account's device list and the trusted-device answers -----------------

const serialize = (device, currentRef, now = new Date()) => {
  const restriction = restrictionOf(device, now);
  return {
    id: String(device._id),
    label: device.label,
    status: device.status,
    current: String(device._id) === String(currentRef || ''),
    restricted: Boolean(restriction),
    ...(restriction && restriction.until ? { restrictedUntil: restriction.until.toISOString() } : {}),
    signedInAt: (device.verifiedAt || device.createdAt).toISOString(),
    lastSeenAt: (device.lastSeenAt || device.updatedAt).toISOString(),
  };
};

/** The devices still waiting for a trusted device's answer (never the caller's own). */
const pendingFor = async (accountId, exceptRef, now = new Date()) => {
  const pending = await Device.find({ accountId: String(accountId), noticePending: true, status: { $in: ['trusted', 'untrusted'] } }).sort({
    verifiedAt: -1,
  });
  return pending.filter((d) => String(d._id) !== String(exceptRef || '') && Boolean(restrictionOf(d, now)));
};

/**
 * `SessionAccess` facts for GET /auth/me: the caller's own restriction, or —
 * on a trusted, unrestricted device — the new devices waiting for its answer.
 */
const accessFacts = async (account, session, now = new Date()) => {
  if (!session || !session.deviceRef) return {};
  const device = await Device.findById(session.deviceRef);
  const restriction = restrictionOf(device, now);
  if (restriction) {
    return {
      deviceRestriction: {
        reason: restriction.reason,
        ...(restriction.until ? { until: restriction.until.toISOString() } : {}),
      },
    };
  }
  if (!device || device.status !== 'trusted') return {};
  const pending = await pendingFor(account._id, device._id, now);
  if (pending.length === 0) return {};
  return {
    pendingDeviceApprovals: pending.map((d) => ({ id: String(d._id), label: d.label, signedInAt: d.verifiedAt.toISOString() })),
  };
};

/** The caller must answer from a trusted device whose own window has ended. */
const assertAnswering = async (req) => {
  const { device, restriction } = req.auth;
  if (!device || device.status !== 'trusted' || restriction) {
    throw AppError.notPermitted('Answer from one of your trusted devices.');
  }
  return device;
};

const loadTarget = async (account, deviceRef) => {
  const target = await Device.findOne({ _id: String(deviceRef), accountId: String(account._id) });
  if (!target || target.status === 'blocked') throw AppError.notFound('device');
  return target;
};

/** "Yes, this is my device": lift its restriction now (trusting it if a slot is free). */
const approve = async (req, deviceRef) => {
  const { account } = req.auth;
  const caller = await assertAnswering(req);
  const target = await loadTarget(account, deviceRef);
  if (String(target._id) === String(caller._id)) throw AppError.validation({ deviceId: 'This is the device you are using.' });
  if (target.status === 'untrusted' && (await trustedCount(account._id)) >= config.trustedDevicesMax) {
    throw new AppError('trusted_device_limit', 409, 'Remove a trusted device first.', { limit: config.trustedDevicesMax });
  }
  const now = new Date();
  target.status = 'trusted';
  target.approvedAt = now;
  target.restrictedUntil = null;
  target.noticePending = false;
  await target.save();
  return target;
};

/** Who is told when a device is denied: a team's Main Admin, or the Super Admins. */
const notifyResponsible = async (account, target) => {
  const params = { name: account.name || account.email, email: account.email, label: target.label };
  if (account.role === 'admin' && account.saasTenantId) {
    const tenant = await SaasTenant.findById(account.saasTenantId);
    const mainId = tenant && tenant.seat && tenant.seat.currentAccountId;
    const main = mainId ? await Account.findById(mainId) : null;
    if (main && main.email && String(main._id) !== String(account._id)) {
      await emailService.sendTemplate(main.email, 'deviceDeniedAlert', params);
    }
    return;
  }
  if (account.role === 'main_admin' || account.role === 'super_admin') {
    const supers = await Account.find({ role: 'super_admin', status: 'active', _id: { $ne: String(account._id) } });
    for (const s of supers) {
      // eslint-disable-next-line no-await-in-loop
      if (s.email) await emailService.sendTemplate(s.email, 'deviceDeniedAlert', params);
    }
    await securityService.signal('new_device_denied', { accountId: String(account._id), tenantId: account.saasTenantId || undefined });
  }
};

/**
 * "No, this is not me": block that device, end EVERY session of the account
 * (the answering one too), require a password reset when the account has a
 * password, and tell the responsible admin.
 * @returns {{ passwordReset: boolean }}
 */
const deny = async (req, deviceRef) => {
  const { account } = req.auth;
  const caller = await assertAnswering(req);
  const target = await loadTarget(account, deviceRef);
  if (String(target._id) === String(caller._id)) throw AppError.validation({ deviceId: 'This is the device you are using.' });
  const now = new Date();
  target.status = 'blocked';
  target.blockedAt = now;
  target.noticePending = false;
  target.restrictedUntil = null;
  await target.save();

  const passwordReset = (account.methods || []).includes('password');
  if (passwordReset) {
    await Account.updateOne({ _id: account._id }, { $set: { passwordResetRequired: true } });
  }
  await require('./tokenService').revokeAllForAccount(account._id, 'new_device_denied');
  await notifyResponsible(account, target);
  return { passwordReset };
};

/** Remove a device from the account: its sessions end; it is a new device next time. */
const remove = async (req, deviceRef) => {
  const { account, session } = req.auth;
  // A blocked device stays blocked: removing it would let it sign in again.
  const target = await Device.findOne({ _id: String(deviceRef), accountId: String(account._id), status: { $ne: 'blocked' } });
  if (!target) throw AppError.notFound('device');
  if (String(target._id) === String(session.deviceRef || '')) {
    throw AppError.validation({ deviceId: 'Sign out to leave the device you are using.' });
  }
  await Session.updateMany(
    { accountId: String(account._id), deviceRef: String(target._id), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokeReason: 'device_removed' } },
  );
  await Device.deleteOne({ _id: target._id });
};

const list = async (account, session, now = new Date()) => {
  // Trusted first, then untrusted; blocked devices are not listed.
  const devices = await Device.find({ accountId: String(account._id), status: { $ne: 'blocked' } }).sort({ status: 1, lastSeenAt: -1 });
  return {
    limit: config.trustedDevicesMax,
    devices: devices.map((d) => serialize(d, session && session.deviceRef, now)),
  };
};

module.exports = {
  UUID_V4,
  hashId,
  readDeviceId,
  admit,
  isTrusted,
  assertNotBlocked,
  restrictionOf,
  bindLegacySession,
  accessFacts,
  approve,
  deny,
  remove,
  list,
};
