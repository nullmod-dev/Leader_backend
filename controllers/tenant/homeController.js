/**
 * Home — /api/v1/home (Flutter /home, the Today dashboard).
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { Detachment } = require('../../models');
const homeService = require('../../services/homeService');

/**
 * Middleware: load `?detachmentId` into req.docs.detachment and require
 * `detachment.view` there. Not in this tenant → 404 not_found; not visible →
 * 403 not_permitted (the client renders each as its own state).
 */
exports.detachmentFromQuery = catchAsync(async (req, res, next) => {
  const det = await Detachment.findOne({ _id: req.query.detachmentId, tenantId: req.tenantId });
  if (!det) throw AppError.notFound('detachment');
  if (!caps.canIn(req.grant, String(det._id), 'detachment.view')) {
    throw AppError.notPermitted('Requires detachment.view in this detachment.');
  }
  req.docs = req.docs || {};
  req.docs.detachment = det;
  next();
});

// GET /home/summary?detachmentId
exports.summary = catchAsync(async (req, res) => {
  res.json(await homeService.summary({ tenant: req.tenant, detachment: req.docs.detachment, grant: req.grant, tz: req.tz }));
});

// GET /home/overview
exports.overview = catchAsync(async (req, res) => {
  res.json(await homeService.overview({ tenant: req.tenant, grant: req.grant, tz: req.tz }));
});
