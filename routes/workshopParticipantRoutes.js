/**
 * /api/v1/workshop-participants/:participantId — one register line.
 * tenantGuard → feature `workshops` → global capability → line in this
 * tenant (404) → its workshop not archived (409 archived).
 * See docs/api/workshops.md.
 */
const express = require('express');
const { tenantGuard, requireFeature, requireCap, loadTenantDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const catchAsync = require('../utils/catchAsyncErrors');
const { WorkshopParticipant, Workshop } = require('../models');
const workshopService = require('../services/workshopService');
const v = require('../validators/workshopValidators');
const register = require('../controllers/tenant/workshopParticipantController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard, requireFeature('workshops'));

const load = loadTenantDoc(WorkshopParticipant, 'participantId', 'participant');
/** The line's workshop must exist and not be archived. */
const writable = catchAsync(async (req, res, next) => {
  const w = await Workshop.findOne({ _id: req.docs.participant.workshopId, tenantId: req.tenantId });
  workshopService.assertWritable(w);
  req.docs.workshop = w;
  next();
});

router.put('/:participantId', requireCap('workshop.people.manage'), load, writable, idempotent(), validate(v.teamMember), register.update);
router.delete('/:participantId', requireCap('workshop.people.manage'), load, writable, idempotent(), register.remove);
router.patch(
  '/:participantId/attendance',
  requireCap('workshop.attendance.record'),
  load,
  writable,
  idempotent(),
  validate(v.attendance),
  register.setAttendance,
);
router.patch(
  '/:participantId/payment',
  requireCap('workshop.payment.record'),
  load,
  writable,
  idempotent(),
  validate(v.payment),
  register.setPayment,
);

module.exports = router;
