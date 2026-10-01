/**
 * /api/v1/shifts/:shiftId — one shift, its assignments and its attendance.
 *
 * loadTenantDoc (404 not_found outside this tenant) → capability in the
 * shift's own detachment → Idempotency-Key (optional) → validation.
 * See docs/api/shifts.md.
 */
const express = require('express');
const { tenantGuard, requireCapIn, requireAnyCapIn, loadTenantDoc, fromDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { Shift } = require('../models');
const v = require('../validators/shiftValidators');
const shifts = require('../controllers/tenant/shiftController');
const attendance = require('../controllers/tenant/attendanceController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

const load = loadTenantDoc(Shift, 'shiftId', 'shift');
const cap = (key) => requireCapIn(key, fromDoc('shift'));
const recordOrOverride = requireAnyCapIn(['shift.attendance.record', 'shift.attendance.override'], fromDoc('shift'));

router.get('/:shiftId', load, cap('detachment.view'), shifts.get);
router.put('/:shiftId', load, cap('shift.manage'), idempotent(), validate(v.updateShift), shifts.update);
router.patch('/:shiftId', load, cap('shift.manage'), idempotent(), validate(v.updateShift), shifts.update);
router.delete('/:shiftId', load, cap('shift.delete'), idempotent(), shifts.remove);
router.put('/:shiftId/repeat', load, cap('shift.manage'), idempotent(), validate(v.repeat), shifts.updateRepeat);

router.post('/:shiftId/assignments', load, cap('shift.assign'), idempotent(), validate(v.assign), shifts.assign);
router.delete('/:shiftId/assignments/:memberId', load, cap('shift.assign'), idempotent(), shifts.unassign);
router.get('/:shiftId/candidates', load, cap('shift.assign'), shifts.candidates);
router.post('/:shiftId/quick-fill', load, cap('shift.assign'), idempotent(), shifts.quickFill);

router.post('/:shiftId/members/:memberId/check-in', load, recordOrOverride, idempotent(), validate(v.at), attendance.checkIn);
router.post('/:shiftId/members/:memberId/check-out', load, recordOrOverride, idempotent(), validate(v.at), attendance.checkOut);
router.post('/:shiftId/members/:memberId/absent', load, recordOrOverride, idempotent(), attendance.absent);
router.post('/:shiftId/members/:memberId/reset', load, recordOrOverride, idempotent(), attendance.reset);
router.patch('/:shiftId/members/:memberId/attendance', load, recordOrOverride, idempotent(), validate(v.markAttendance), attendance.mark);

router.post(
  '/:shiftId/members/:memberId/attendance-corrections',
  load,
  cap('shift.attendance.override'),
  idempotent(),
  validate(v.correction),
  attendance.correct,
);
router.get('/:shiftId/attendance-corrections', load, cap('detachment.view'), attendance.listCorrections);

module.exports = router;
