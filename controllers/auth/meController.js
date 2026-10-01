/**
 * The signed-in account: GET/PATCH /auth/me, avatar, password change.
 * Every body is { user: AuthUser, access: SessionAccess } (services/sessionView).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Account } = require('../../models');
const storageService = require('../../services/storageService');
const tokenService = require('../../services/tokenService');
const onboarding = require('../../services/onboardingService');
const { collapse } = require('../../utils/normalize');
const { DISPLAY_NAME_MAX } = require('../../config/constants');

const respondMe = async (res, account, session) => {
  res.status(200).json(await onboarding.meView(account, session));
};

// GET /auth/me
exports.get = catchAsync(async (req, res) => {
  await respondMe(res, req.auth.account, req.auth.session);
});

// PATCH /auth/me {name}
exports.update = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  const name = collapse(req.body.name);
  if (!name || name.length > DISPLAY_NAME_MAX) {
    throw AppError.validation({ name: `The name must be 1–${DISPLAY_NAME_MAX} characters.` });
  }
  account.name = name;
  await account.save();
  await respondMe(res, account, session);
});

// POST /auth/me/avatar (multipart `image`)
exports.setAvatar = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  let saved;
  try {
    saved = await storageService.saveImage(req.file.buffer, 'avatar', {
      ownerType: 'account',
      ownerId: String(account._id),
      tenantId: account.saasTenantId || null,
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.validation({ image: 'The file is not a readable image.' });
  }
  const previous = account.avatarPath;
  account.avatarPath = saved.path;
  account.avatarBytes = saved.bytes;
  await account.save();
  if (previous && previous !== saved.path) await storageService.removeFile(previous);
  await respondMe(res, account, session);
});

// DELETE /auth/me/avatar
exports.removeAvatar = catchAsync(async (req, res) => {
  const { account, session } = req.auth;
  const previous = account.avatarPath;
  if (previous) {
    account.set('avatarPath', undefined);
    account.avatarBytes = 0;
    await account.save();
    await storageService.removeFile(previous);
  }
  await respondMe(res, account, session);
});

// POST /auth/me/password {currentPassword, newPassword} → 204
exports.changePassword = catchAsync(async (req, res) => {
  const { session } = req.auth;
  const account = await Account.findById(req.auth.account._id).select('+passwordHash');
  const ok = (account.methods || []).includes('password') && (await account.checkPassword(req.body.currentPassword));
  if (!ok) {
    throw new AppError('invalid_credentials', 422, 'The current password is not correct.', {
      fields: { currentPassword: 'The current password is not correct.' },
    });
  }
  const next = onboarding.assertPasswordPolicy(req.body.newPassword, 'newPassword');
  await account.setPassword(next);
  await account.save();
  await tokenService.revokeAllForAccount(account._id, 'password_changed', { exceptSessionId: session._id });
  res.status(204).end();
});
