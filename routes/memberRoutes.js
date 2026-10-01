/**
 * /api/v1/members — docs/api/members.md
 *
 *   POST   /                      create                member.invite (body detachmentId) · limit members
 *   POST   /from-shift            quick member          member.invite · limit members
 *   GET    /match                 name match            member.view (query detachmentId)
 *   GET    /:memberId             one                   member.view
 *   PUT    /:memberId             full edit             member.edit (+ member.role.assign to change role)
 *   PATCH  /:memberId             partial edit          idem
 *   PATCH  /:memberId/role        role                  member.role.assign
 *   PATCH  /:memberId/attendance  roster attendance     shift.attendance.record
 *   POST   /:memberId/deactivate  lifecycle             member.deactivate
 *   POST   /:memberId/reactivate  lifecycle             member.deactivate · limit members
 *   DELETE /:memberId             delete                member.deactivate
 *   POST   /:memberId/photo       upload (multipart)    member.edit
 *   DELETE /:memberId/photo       remove                member.edit
 *
 * Capabilities are checked in the member's detachment.
 */
const express = require('express');
const { tenantGuard, requireCapIn, loadTenantDoc, fromDoc, fromBody, fromQuery } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { imageUpload } = require('../middlewares/upload');
const { TeamMember } = require('../models');
const v = require('../validators/memberValidators');
const ctrl = require('../controllers/tenant/memberController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

const load = loadTenantDoc(TeamMember, 'memberId', 'member');
const capIn = (key) => requireCapIn(key, fromDoc('member'));

// Body/query-scoped routes validate first so a malformed detachmentId is a 422, not a 403.
router.post('/', validate(v.create), requireCapIn('member.invite', fromBody('detachmentId')), idempotent(), ctrl.create);
router.post('/from-shift', validate(v.fromShift), requireCapIn('member.invite', fromBody('detachmentId')), idempotent(), ctrl.createFromShift);
router.get('/match', validate(v.matchQuery, 'query'), requireCapIn('member.view', fromQuery('detachmentId')), ctrl.match);

router.get('/:memberId', load, capIn('member.view'), ctrl.get);
router.put('/:memberId', load, capIn('member.edit'), validate(v.put), idempotent(), ctrl.update);
router.patch('/:memberId', load, capIn('member.edit'), validate(v.patch), idempotent(), ctrl.update);
router.delete('/:memberId', load, capIn('member.deactivate'), idempotent(), ctrl.remove);

router.patch('/:memberId/role', load, capIn('member.role.assign'), validate(v.setRole), idempotent(), ctrl.setRole);
router.patch('/:memberId/attendance', load, capIn('shift.attendance.record'), validate(v.setAttendance), idempotent(), ctrl.setAttendance);

router.post('/:memberId/deactivate', load, capIn('member.deactivate'), validate(v.lifecycleCommand), idempotent(), ctrl.deactivate);
router.post('/:memberId/reactivate', load, capIn('member.deactivate'), validate(v.lifecycleCommand), idempotent(), ctrl.reactivate);

router.post('/:memberId/photo', load, capIn('member.edit'), imageUpload('image'), idempotent(), ctrl.setPhoto);
router.delete('/:memberId/photo', load, capIn('member.edit'), idempotent(), ctrl.removePhoto);

module.exports = router;
