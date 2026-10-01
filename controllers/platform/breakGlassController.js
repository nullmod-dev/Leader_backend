/**
 * /platform/break-glass — Super Admin emergency access (Point 12).
 * Flutter: /platform/access (management page, activation flow, the persistent
 * PlatformShell strip) and the grant-scoped read-only viewer.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const breakGlassService = require('../../services/breakGlassService');

/** GET /current → { grant | null, readAt } */
exports.current = catchAsync(async (req, res) => {
  const grant = await breakGlassService.current(req.auth.session);
  res.json({ grant: breakGlassService.serialize(grant), readAt: new Date().toISOString() });
});

/** POST /grants (Idempotency-Key) → 201 grant */
exports.activate = catchAsync(async (req, res) => {
  const grant = await breakGlassService.activate(req.auth, req.body);
  res.status(201).json(breakGlassService.serialize(grant));
});

/** POST /grants/:grantId/end (Idempotency-Key) → ended grant */
exports.end = catchAsync(async (req, res) => {
  const grant = await breakGlassService.end(req.auth, req.params.grantId, req.body.expectedRevision);
  res.json(breakGlassService.serialize(grant));
});

/** POST /grants/:grantId/revoke (Idempotency-Key) → ended grant (revoked_by_platform) */
exports.revoke = catchAsync(async (req, res) => {
  const grant = await breakGlassService.revoke(req.auth, req.params.grantId, req.body.expectedRevision);
  res.json(breakGlassService.serialize(grant));
});

/** GET /grants → { items, nextCursor } */
exports.list = catchAsync(async (req, res) => {
  res.json(await breakGlassService.list(req.query));
});

/** GET /view/<resource> → { grantId, tenant, items } */
exports.view = (resource) =>
  catchAsync(async (req, res) => {
    res.json(await breakGlassService.view(req.auth.session, resource, req.query));
  });
