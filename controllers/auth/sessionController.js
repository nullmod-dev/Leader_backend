/**
 * Session lifecycle: sign-out, refresh rotation, the account's device list
 * (/more/security) and the new-device confirmation.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Session } = require('../../models');
const tokenService = require('../../services/tokenService');

const serializeSession = (s, currentId) => ({
  id: String(s._id),
  device: s.device || 'Unknown device',
  ipMasked: s.ipMasked || 'unknown',
  locationLabel: s.locationLabel || '',
  startedAt: s.createdAt.toISOString(),
  current: String(s._id) === String(currentId),
  lastUsedAt: (s.lastUsedAt || s.createdAt).toISOString(),
});

const liveFullFilter = (accountId) => ({
  accountId: String(accountId),
  scope: 'full',
  revokedAt: { $exists: false },
  refreshExpiresAt: { $gt: new Date() },
});

// POST /auth/sign-out → 204
exports.signOut = catchAsync(async (req, res) => {
  await tokenService.revokeSession(req.auth.session, 'signed_out');
  res.status(204).end();
});

// POST /auth/refresh {refreshToken} → { sessionId, accessToken, refreshToken }
exports.refresh = catchAsync(async (req, res) => {
  const token = req.body && typeof req.body.refreshToken === 'string' ? req.body.refreshToken : null;
  res.status(200).json(tokenService.pair(await tokenService.refresh(token, req)));
});

// GET /auth/sessions → [Session]
exports.list = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  const sessions = await Session.find(liveFullFilter(account._id)).sort({ createdAt: -1, _id: -1 });
  res.status(200).json(sessions.map((s) => serializeSession(s, session._id)));
});

// DELETE /auth/sessions/:sessionId → 204
exports.revokeOne = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  const { sessionId } = req.params;
  if (sessionId === String(session._id)) {
    throw AppError.validation({ sessionId: 'Use sign-out to end the current session.' });
  }
  const target = await Session.findOne({ _id: sessionId, ...liveFullFilter(account._id) });
  if (!target) throw AppError.notFound('session');
  await tokenService.revokeSession(target, 'revoked_by_user');
  res.status(204).end();
});

// DELETE /auth/sessions → { revoked: n }  (every OTHER session)
exports.revokeOthers = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  const revoked = await tokenService.revokeAllForAccount(account._id, 'revoked_by_user', { exceptSessionId: session._id });
  res.status(200).json({ revoked });
});

// POST /auth/new-device/confirm {itsMe} → 204
exports.confirmNewDevice = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  if (req.body.itsMe) {
    session.newDeviceConfirmed = true;
    await session.save();
  } else {
    // "Not me": end every session of the account, this one included.
    await tokenService.revokeAllForAccount(account._id, 'new_device_denied');
  }
  res.status(204).end();
});
