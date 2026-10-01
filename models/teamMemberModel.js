/**
 * TeamMember — a volunteer record. NEVER a login account.
 *
 * Wire (team_models.dart TeamMember.fromJson):
 *   { id, name, initials, department, personalNumber, role, detachmentId,
 *     attendance, phoneMasked?, photoUrl?, active, version }
 *
 *  - role: shiftSupervisor | administrator | followUp | member
 *    (legacy lead/medic/trainee/volunteer accepted on input only)
 *  - attendance: notCheckedIn | checkedIn | checkedOut | absent — the ROSTER
 *    value is vestigial; real attendance lives on each Shift attendee.
 *  - phone is stored in full but only ever leaves as `phoneMasked`, and only to
 *    a session holding `member.contact.view` in that detachment.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');
const { TEAM_ROLES, ATTENDANCE_STATES } = require('../config/constants');

const teamMemberSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    detachmentId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    initials: { type: String, default: '' },
    department: { type: String, default: '' },
    personalNumber: { type: String, default: '' },
    role: { type: String, enum: TEAM_ROLES, default: 'member' },
    attendance: { type: String, enum: ATTENDANCE_STATES, default: 'notCheckedIn' },
    phone: { type: String, default: null },
    photoPath: { type: String, default: undefined },
    active: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true, collection: 'team_members' },
);

teamMemberSchema.plugin(basePlugin, { prefix: 'm', versioned: true, changeLog: 'team_member' });
teamMemberSchema.index({ tenantId: 1, detachmentId: 1, nameKey: 1 }, { unique: true });
teamMemberSchema.index(
  { tenantId: 1, detachmentId: 1, personalNumber: 1 },
  { unique: true, partialFilterExpression: { personalNumber: { $gt: '' } } },
);

teamMemberSchema.pre('validate', function setDerived(next) {
  const { nameKey, initialsOf, collapse } = require('../utils/normalize');
  if (this.name) {
    this.name = collapse(this.name);
    this.nameKey = nameKey(this.name);
    this.initials = initialsOf(this.name);
  }
  next();
});

module.exports = mongoose.models.TeamMember || mongoose.model('TeamMember', teamMemberSchema);
