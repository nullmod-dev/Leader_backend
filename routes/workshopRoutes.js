/**
 * /api/v1/workshops — organisation-level workshops, their register and
 * organising team. Every route: tenantGuard → feature `workshops`.
 * workshop.* capabilities are GLOBAL (requireCap). Mutations of an archived
 * workshop → 409 archived (the archive endpoint itself excepted).
 * See docs/api/workshops.md.
 */
const express = require('express');
const { tenantGuard, requireFeature, requireCap, loadTenantDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const { Workshop } = require('../models');
const workshopService = require('../services/workshopService');
const v = require('../validators/workshopValidators');
const workshops = require('../controllers/tenant/workshopController');
const register = require('../controllers/tenant/workshopParticipantController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard, requireFeature('workshops'));

const load = loadTenantDoc(Workshop, 'workshopId', 'workshop');
/** 409 archived for any mutation of an archived workshop. */
const writable = (req, res, next) => {
  if (req.docs.workshop.archived) return next(workshopService.archivedError());
  return next();
};

router.get('/', validate(v.listQuery, 'query'), workshops.list);
router.post('/', requireCap('workshop.create'), idempotent(), validate(v.create), workshops.create);

router.get('/:workshopId', load, workshops.get);
router.put('/:workshopId', requireCap('workshop.edit'), load, writable, idempotent(), validate(v.update), workshops.update);
router.patch('/:workshopId', requireCap('workshop.edit'), load, writable, idempotent(), validate(v.update), workshops.update);
router.patch('/:workshopId/archive', requireCap('workshop.archive'), load, idempotent(), validate(v.archive), workshops.archive);

// Multipart: no Idempotency-Key replay (the body hash cannot see the file).
router.post('/:workshopId/cover', requireCap('workshop.edit'), load, writable, imageUpload('image'), workshops.setCover);
router.delete('/:workshopId/cover', requireCap('workshop.edit'), load, writable, idempotent(), workshops.removeCover);

router.get('/:workshopId/participants', load, workshops.participants);
router.post(
  '/:workshopId/team-members',
  requireCap('workshop.people.manage'),
  load,
  writable,
  idempotent(),
  validate(v.teamMember),
  register.addTeamMember,
);
router.post('/:workshopId/guests', requireCap('workshop.people.manage'), load, writable, idempotent(), validate(v.guest), register.addGuest);
router.post(
  '/:workshopId/participants',
  requireCap('workshop.people.manage'),
  load,
  writable,
  idempotent(),
  validate(v.legacyParticipants),
  register.addRosterMembers,
);

router.post(
  '/:workshopId/organizers',
  requireCap('workshop.people.manage'),
  load,
  writable,
  idempotent(),
  validate(v.organizers),
  workshops.addOrganizers,
);
router.delete('/:workshopId/organizers/:memberId', requireCap('workshop.people.manage'), load, writable, idempotent(), workshops.removeOrganizer);
router.patch(
  '/:workshopId/organizers/:memberId/attendance',
  requireCap('workshop.attendance.record'),
  load,
  writable,
  idempotent(),
  validate(v.attendance),
  workshops.setOrganizerAttendance,
);

router.get('/:workshopId/stats', requireFeature('statistics_reports'), load, workshops.stats);
router.get('/:workshopId/export.csv', load, workshops.exportCsv);

module.exports = router;
