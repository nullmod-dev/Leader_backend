/**
 * Shifts. A `ShiftTemplate` is a weekly repeat (a set of calendar days); each
 * day materializes one `Shift`. A shift can also stand alone (no templateId).
 *
 * Wire — Shift (shift_models.dart Shift.fromJson):
 *   { id, detachmentId, templateId?, date: "YYYY-MM-DD", centerName,
 *     startMinutes, endMinutes, needed, attendees: [TeamMember + per-shift
 *     attendance/checkInAt/checkOutAt], corrections?: [AttendanceCorrection],
 *     version, startsAt, endsAt, assigned, hasCoverageGap, crossesMidnight }
 *
 * `date` is the tenant-local calendar day the shift STARTS on. `endMinutes <=
 * startMinutes` means the shift crosses midnight. `startsAt`/`endsAt` are the
 * server-computed UTC instants in the tenant timezone — the attendance edit
 * window (end + grace) is evaluated against them with SERVER time.
 *
 * Corrections are APPEND-ONLY: there is no update or delete path for them.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { ATTENDANCE_STATES } = require('../config/constants');

const attendeeSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true },
    attendance: { type: String, enum: ATTENDANCE_STATES, default: 'notCheckedIn' },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    assignedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const snapshotSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ATTENDANCE_STATES, required: true },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
  },
  { _id: false },
);

const correctionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    memberId: { type: String, required: true },
    before: { type: snapshotSchema, required: true },
    after: { type: snapshotSchema, required: true },
    reason: { type: String, required: true },
    author: { id: String, displayName: String },
    correctedAt: { type: Date, required: true }, // SERVER time — authoritative
    clientCorrectedAt: { type: Date, default: null }, // advisory, what the device read
  },
  { _id: false },
);

const shiftSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentId: { type: String, required: true },
    templateId: { type: String, default: null },
    date: { type: String, required: true }, // YYYY-MM-DD, tenant-local
    centerName: { type: String, required: true, trim: true },
    startMinutes: { type: Number, required: true, min: 0, max: 1439 },
    endMinutes: { type: Number, required: true, min: 0, max: 1440 },
    needed: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    attendees: { type: [attendeeSchema], default: [] },
    corrections: { type: [correctionSchema], default: [] },
  },
  { timestamps: true, collection: 'shifts' },
);

shiftSchema.plugin(basePlugin, { prefix: 'sh', versioned: true, changeLog: 'shift' });
shiftSchema.index({ tenantId: 1, detachmentId: 1, date: 1, startMinutes: 1 });
shiftSchema.index({ tenantId: 1, templateId: 1 });
shiftSchema.index({ tenantId: 1, 'attendees.memberId': 1, startsAt: 1 });

const shiftTemplateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentId: { type: String, required: true },
    centerName: { type: String, required: true, trim: true },
    dates: { type: [String], default: [] }, // sorted, de-duplicated YYYY-MM-DD
    startMinutes: { type: Number, required: true, min: 0, max: 1439 },
    endMinutes: { type: Number, required: true, min: 0, max: 1440 },
    needed: { type: Number, required: true, min: 1 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'shift_templates' },
);

shiftTemplateSchema.plugin(basePlugin, { prefix: 'tpl', versioned: true, changeLog: 'shift_template' });
shiftTemplateSchema.index({ tenantId: 1, detachmentId: 1, active: 1 });

module.exports = {
  Shift: mongoose.models.Shift || mongoose.model('Shift', shiftSchema),
  ShiftTemplate: mongoose.models.ShiftTemplate || mongoose.model('ShiftTemplate', shiftTemplateSchema),
};
