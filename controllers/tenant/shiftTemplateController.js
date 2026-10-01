/**
 * Shift templates — the weekly repeat behind a set of shifts (the repeat
 * section of the shift manage sheet).
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const { assertVersion } = require('../../services/versioning');
const serializers = require('../../services/serializers');
const shiftService = require('../../services/shiftService');

const { saveOrStale } = shiftService;
const { ShiftTemplate, Shift } = require('../../models');

/** GET /detachments/:detachmentId/shift-templates?active= */
exports.listForDetachment = catchAsync(async (req, res) => {
  const filter = { tenantId: req.tenantId, detachmentId: req.params.detachmentId };
  if (typeof req.query.active === 'boolean') filter.active = req.query.active;
  const list = await ShiftTemplate.find(filter);
  const firstDay = (t) => [...(t.dates || [])].sort()[0] || '9999-12-31';
  list.sort((a, b) => firstDay(a).localeCompare(firstDay(b)) || a.startMinutes - b.startMinutes);
  res.json(list.map(serializers.template));
});

exports.get = catchAsync(async (req, res) => {
  res.json(serializers.template(req.docs.template));
});

exports.shifts = catchAsync(async (req, res) => {
  const list = await Shift.find({ tenantId: req.tenantId, templateId: String(req.docs.template._id) }).sort(shiftService.ORDER);
  res.json(await shiftService.toJsonMany(req, list));
});

exports.updateDates = catchAsync(async (req, res) => {
  const result = await shiftService.updateTemplateDates({
    tenantId: req.tenantId,
    tz: req.tz,
    template: req.docs.template,
    dates: req.body.dates,
    version: req.body.version,
    serialize: serializers.template,
  });
  res.json({
    template: serializers.template(result.template),
    created: result.created,
    removed: result.removed,
    kept: result.kept,
  });
});

/** Deactivate, never delete: the shifts it produced still point at it. */
exports.stop = catchAsync(async (req, res) => {
  const t = req.docs.template;
  assertVersion(t, req.body && req.body.version, serializers.template);
  if (t.active !== false) {
    t.active = false;
    await saveOrStale(t, serializers.template);
  }
  res.json(serializers.template(t));
});
