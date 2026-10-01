/**
 * /platform/settings — platform policy values (screen: platform settings).
 * The Customer Demo policy (`demo`) is NOT part of this resource: it has its
 * own endpoints and revision (/platform/demo).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const { iso } = require('../../utils/time');

const SCALAR_KEYS = [
  'minimumClientVersion',
  'defaultTimezone',
  'trialDays',
  'graceDays',
  'deletionWindowDays',
  'breakGlassMinutes',
  'invitationDays',
  'idempotencyRetentionDays',
  'attendanceGraceMinutes',
  'recentAuthMinutes',
];
const NESTED = {
  otp: ['length', 'ttlMinutes', 'maxAttempts', 'resendCooldownSeconds'],
  signInLockout: ['maxFailures', 'windowMinutes'],
  support: ['email', 'telegram', 'whatsapp'],
};

const serializeSettings = (s) => {
  const out = {};
  SCALAR_KEYS.forEach((k) => {
    out[k] = s[k];
  });
  Object.entries(NESTED).forEach(([group, keys]) => {
    out[group] = {};
    keys.forEach((k) => {
      out[group][k] = s[group] ? s[group][k] : undefined;
    });
  });
  out.updatedAt = iso(s.updatedAt);
  return out;
};

/** GET /platform/settings */
exports.get = catchAsync(async (req, res) => {
  res.json(serializeSettings(await settingsService.get()));
});

/** PATCH /platform/settings (partial; nested groups patch key by key) */
exports.update = catchAsync(async (req, res) => {
  const current = await settingsService.get();
  const patch = {};
  const changed = [];
  SCALAR_KEYS.forEach((k) => {
    if (req.body[k] === undefined) return;
    patch[k] = req.body[k];
    if (current[k] !== req.body[k]) changed.push(k);
  });
  Object.entries(NESTED).forEach(([group, keys]) => {
    const incoming = req.body[group];
    if (!incoming) return;
    keys.forEach((k) => {
      if (incoming[k] === undefined) return;
      patch[`${group}.${k}`] = incoming[k];
      if (!current[group] || current[group][k] !== incoming[k]) changed.push(`${group}.${k}`);
    });
  });

  let fresh = current;
  if (changed.length) {
    fresh = await settingsService.update(patch);
    await auditService.record({
      action: 'platform_settings_changed',
      actor: req.auth.account,
      target: { type: 'platform_settings', id: 'global' },
      changes: changed.map((k) => ({ field: 'setting_value', before: k, after: k })),
    });
  }
  res.json(serializeSettings(fresh));
});

exports.serializeSettings = serializeSettings;
