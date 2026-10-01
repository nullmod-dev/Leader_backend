/**
 * /api/v1/detachments/:detachmentId/{shifts,shift-templates} — the
 * detachment's schedule. Only paths under /shifts and /shift-templates are
 * defined here (the rest of /detachments/:id belongs to detachmentRoutes).
 *
 * Every request: tenantGuard → the detachment must exist IN THIS TENANT
 * (404 not_found) → the capability is checked on that detachment id.
 * See docs/api/shifts.md.
 */
const express = require('express');
const { tenantGuard, requireCapIn, loadTenantDoc, fromParam } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { Detachment } = require('../models');
const v = require('../validators/shiftValidators');
const shifts = require('../controllers/tenant/shiftController');
const templates = require('../controllers/tenant/shiftTemplateController');

const router = express.Router({ mergeParams: true });

router.use(['/shifts', '/shift-templates'], tenantGuard, loadTenantDoc(Detachment, 'detachmentId', 'detachment'));

const cap = (key) => requireCapIn(key, fromParam('detachmentId'));

router.get('/shifts/today', cap('detachment.view'), shifts.today);
router.get('/shifts/week', cap('detachment.view'), validate(v.week, 'query'), shifts.week);
router.get('/shifts', cap('detachment.view'), validate(v.range, 'query'), shifts.range);
router.post('/shifts', cap('shift.manage'), idempotent(), validate(v.createShift), shifts.create);
router.post('/shifts/copy-day', cap('shift.manage'), idempotent(), validate(v.copyDay), shifts.copyDay);
router.post('/shifts/copy-week', cap('shift.manage'), idempotent(), validate(v.copyWeek), shifts.copyWeek);

router.get('/shift-templates', cap('detachment.view'), validate(v.templatesQuery, 'query'), templates.listForDetachment);

module.exports = router;
