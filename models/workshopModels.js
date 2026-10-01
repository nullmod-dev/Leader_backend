/**
 * Workshops are ORGANISATION-level (no detachment id; all `workshop.*` keys
 * are global). Every workshop owns its own register.
 *
 * Wire — Workshop (workshop_models.dart):
 *   { id, name, at (instant), location, capacity, registered, guests, status:
 *     scheduled|ongoing|done, registrationFee, archived, organizingTeam:
 *     [TeamMember + this workshop's attendance], coverImageUrl?, version }
 *   `registered`/`guests` are SERVER-DERIVED counts of the register.
 *   `registrationFee` is a plain number in the tenant's local currency (the
 *   app renders ل.س); 0 = free.
 *
 * Wire — WorkshopParticipant:
 *   { id, workshopId, name, initials, kind: member|guest, role? (member only:
 *     leader|trainer|support|management|member), memberId? (legacy roster
 *     link), attendance, paymentStatus?: paid|unpaid, version }
 *
 * Seats: everyone on the register takes one; organisers never do.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { WORKSHOP_STATUS, PARTICIPANT_KINDS, WORKSHOP_ROLES, PAYMENT_STATUS, ATTENDANCE_STATES } = require('../config/constants');

const organizerSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true },
    attendance: { type: String, enum: ATTENDANCE_STATES, default: 'notCheckedIn' },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
  },
  { _id: false },
);

const workshopSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    at: { type: Date, required: true },
    location: { type: String, required: true, trim: true },
    capacity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: WORKSHOP_STATUS, default: 'scheduled' },
    registrationFee: { type: Number, default: 0, min: 0 },
    archived: { type: Boolean, default: false },
    archivedAt: Date,
    organizingTeam: { type: [organizerSchema], default: [] },
    coverImagePath: { type: String, default: undefined },
  },
  { timestamps: true, collection: 'workshops' },
);

workshopSchema.plugin(basePlugin, { prefix: 'w', versioned: true, changeLog: 'workshop' });
workshopSchema.index({ tenantId: 1, at: 1 });

const participantSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    workshopId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    initials: { type: String, default: '' },
    kind: { type: String, enum: PARTICIPANT_KINDS, required: true },
    role: { type: String, enum: [...WORKSHOP_ROLES, null], default: null },
    memberId: { type: String, default: undefined },
    attendance: { type: String, enum: ATTENDANCE_STATES, default: 'notCheckedIn' },
    paymentStatus: { type: String, enum: [...PAYMENT_STATUS, null], default: null },
  },
  { timestamps: true, collection: 'workshop_participants' },
);

participantSchema.plugin(basePlugin, { prefix: 'p', versioned: true, changeLog: 'workshop_participant' });
participantSchema.index({ tenantId: 1, workshopId: 1, kind: 1, nameKey: 1 });

participantSchema.pre('validate', function setDerived(next) {
  const { nameKey, initialsOf, collapse } = require('../utils/normalize');
  if (this.name) {
    this.name = collapse(this.name);
    this.nameKey = nameKey(this.name);
    this.initials = initialsOf(this.name);
  }
  if (this.kind === 'guest') this.role = null;
  next();
});

module.exports = {
  Workshop: mongoose.models.Workshop || mongoose.model('Workshop', workshopSchema),
  WorkshopParticipant: mongoose.models.WorkshopParticipant || mongoose.model('WorkshopParticipant', participantSchema),
};
