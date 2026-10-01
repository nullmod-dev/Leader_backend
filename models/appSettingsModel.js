/**
 * Platform-wide policy values, in ONE document (`_id: "global"`).
 *
 * Every value the docs mark "backend policy / provisional" lives here so a
 * Super Admin can change it from the dashboard instead of a redeploy:
 * trial/grace/deletion windows, break-glass duration, invitation validity,
 * OTP policy, the minimum supported client version, and the Customer Demo
 * global policy (enabled, default duration, revision).
 */
const mongoose = require('mongoose');

const appSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    minimumClientVersion: { type: String, default: '1.0.0' },
    defaultTimezone: { type: String, default: 'Asia/Damascus' },

    trialDays: { type: Number, default: 14, min: 1 },
    graceDays: { type: Number, default: 14, min: 0 },
    deletionWindowDays: { type: Number, default: 30, min: 0 },
    breakGlassMinutes: { type: Number, default: 60, min: 5 },
    invitationDays: { type: Number, default: 7, min: 1 },
    idempotencyRetentionDays: { type: Number, default: 7, min: 1 },
    attendanceGraceMinutes: { type: Number, default: 60, min: 0 },
    recentAuthMinutes: { type: Number, default: 30, min: 1 },

    otp: {
      length: { type: Number, default: 6, min: 4, max: 10 },
      ttlMinutes: { type: Number, default: 10, min: 1 },
      maxAttempts: { type: Number, default: 5, min: 1 },
      resendCooldownSeconds: { type: Number, default: 60, min: 0 },
    },

    signInLockout: {
      maxFailures: { type: Number, default: 5, min: 1 },
      windowMinutes: { type: Number, default: 15, min: 1 },
    },

    demo: {
      enabled: { type: Boolean, default: true },
      defaultDurationMinutes: { type: Number, default: 1440, min: 60 },
      maxDurationMinutes: { type: Number, default: 43200, min: 60 }, // 30 days
      revision: { type: Number, default: 1 },
      updatedBy: { accountId: String, displayName: String },
      updatedAt: Date,
    },

    support: {
      email: { type: String, default: 'support@leader.app' },
      telegram: { type: String, default: '' },
      whatsapp: { type: String, default: '' },
    },
  },
  { timestamps: true, versionKey: false, collection: 'app_settings' },
);

module.exports = mongoose.models.AppSettings || mongoose.model('AppSettings', appSettingsSchema);
