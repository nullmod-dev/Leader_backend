/**
 * GET /tenant/audit — the tenant-scoped audit stream (Simple Admin
 * management events), newest first, cursor-paged.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { AuditEvent } = require('../../models');
const cursorUtil = require('../../utils/cursor');

exports.list = catchAsync(async (req, res) => {
  const limit = cursorUtil.limitOf(req.query.limit, 50, 100);
  const c = cursorUtil.decode(req.query.cursor);
  const filter = { stream: 'tenant', tenantScopeId: req.tenantId };
  if (c) {
    const t = new Date(c.t);
    if (!c.t || Number.isNaN(t.getTime()) || typeof c.id !== 'string') {
      throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
    }
    filter.$or = [{ occurredAt: { $lt: t } }, { occurredAt: t, _id: { $lt: c.id } }];
  }
  const rows = await AuditEvent.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.json({
    items: page.map((e) => e.toJSON()),
    nextCursor: rows.length > limit && last ? cursorUtil.encode({ t: last.occurredAt.toISOString(), id: String(last._id) }) : null,
  });
});
