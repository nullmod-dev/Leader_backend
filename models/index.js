/** Single import point for every model. */
const { Shift, ShiftTemplate } = require('./shiftModels');
const { InventoryItem, InventoryMovement } = require('./inventoryModels');
const { Workshop, WorkshopParticipant } = require('./workshopModels');
const { GlobalOffer, Coupon, BillingOrder, CouponRedemption } = require('./commerceModels');
const { IdempotencyRecord, DevMail, StoredFile, JobRun } = require('./systemModels');

module.exports = {
  // identity
  Account: require('./accountModel'),
  Session: require('./sessionModel'),
  VerificationChallenge: require('./verificationChallengeModel'),
  PasswordReset: require('./passwordResetModel'),
  Authorization: require('./authorizationModel'),
  // control plane
  SaasTenant: require('./saasTenantModel'),
  TenantStatusEvent: require('./tenantStatusEventModel'),
  TenantTombstone: require('./tenantTombstoneModel'),
  RetiredTeamCode: require('./retiredTeamCodeModel'),
  Plan: require('./planModel'),
  AppSettings: require('./appSettingsModel'),
  AuditEvent: require('./auditEventModel'),
  SecuritySignal: require('./securitySignalModel'),
  BreakGlassGrant: require('./breakGlassGrantModel'),
  DemoSession: require('./demoSessionModel'),
  GlobalOffer,
  Coupon,
  BillingOrder,
  CouponRedemption,
  // tenant plane
  DetachmentGroup: require('./detachmentGroupModel'),
  Detachment: require('./detachmentModel'),
  TeamMember: require('./teamMemberModel'),
  Shift,
  ShiftTemplate,
  InventoryItem,
  InventoryMovement,
  Workshop,
  WorkshopParticipant,
  Announcement: require('./announcementModel'),
  NotificationState: require('./notificationStateModel'),
  // infrastructure
  Counter: require('./counterModel'),
  ChangeLog: require('./changeLogModel'),
  IdempotencyRecord,
  DevMail,
  StoredFile,
  JobRun,
};
