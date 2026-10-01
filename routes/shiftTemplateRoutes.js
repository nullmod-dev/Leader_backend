/**
 * /api/v1/shift-templates/:templateId — a weekly repeat and its shifts.
 * Capabilities are checked in the template's detachment.
 * See docs/api/shifts.md.
 */
const express = require('express');
const { tenantGuard, requireCapIn, loadTenantDoc, fromDoc } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const { ShiftTemplate } = require('../models');
const v = require('../validators/shiftValidators');
const templates = require('../controllers/tenant/shiftTemplateController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

const load = loadTenantDoc(ShiftTemplate, 'templateId', 'template');
const cap = (key) => requireCapIn(key, fromDoc('template'));

router.get('/:templateId', load, cap('detachment.view'), templates.get);
router.get('/:templateId/shifts', load, cap('detachment.view'), templates.shifts);
router.put('/:templateId/dates', load, cap('shift.manage'), idempotent(), validate(v.templateDates), templates.updateDates);
router.post('/:templateId/stop', load, cap('shift.manage'), idempotent(), templates.stop);

module.exports = router;
