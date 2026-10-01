/**
 * Global Search — /api/v1/search (Flutter /search).
 *
 * Runs over the caller's VISIBLE, ACTIVE detachments only:
 *   member      name · department · personalNumber   (member.view in that detachment; active members)
 *   detachment  name · region · mainCenter
 *   shift       centerName, dated weekStart − 7 d … weekStart + 20 d (detachment.view)
 *   item        name · unit                           (inventory module on)
 * Matching folds both sides with utils/normalize.searchFold (Arabic alef/ya/
 * ta-marbuta variants, diacritics, digits, case). Ranking: exact title →
 * title prefix → title contains → secondary field; then type order
 * (member, detachment, shift, item); then title.
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { Detachment, TeamMember, Shift, InventoryItem } = require('../../models');
const { SEARCH_TYPES } = require('../../validators/structureValidators');
const { searchFold } = require('../../utils/normalize');
const { todayIn, weekStartOf, addDays } = require('../../utils/time');

const TYPE_ORDER = new Map(SEARCH_TYPES.map((t, i) => [t, i]));

const hhmm = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const joinDot = (...parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').join(' · ');

// GET /search?q&types&limit
exports.search = catchAsync(async (req, res) => {
  const { q, limit } = req.query;
  const types = new Set(req.query.types || SEARCH_TYPES);
  const needle = searchFold(q);
  if (!needle) throw AppError.validation({ q: 'q must contain at least one searchable character.' });

  const score = (title, secondary = []) => {
    const t = searchFold(title);
    if (t === needle) return 0;
    if (t.startsWith(needle)) return 1;
    if (t.includes(needle)) return 2;
    if (secondary.some((s) => s && searchFold(s).includes(needle))) return 3;
    return -1;
  };

  const visible = caps.visibleDetachmentIds(req.grant);
  const detFilter = { tenantId: req.tenantId, status: 'active' };
  if (visible !== null) detFilter._id = { $in: visible };
  const dets = await Detachment.find(detFilter).sort({ createdAt: 1, _id: 1 }).lean();
  const detName = new Map(dets.map((d) => [String(d._id), d.name]));
  const detIds = [...detName.keys()];

  const hits = [];
  const push = (s, row) => {
    if (s >= 0) hits.push({ s, row });
  };

  if (detIds.length && types.has('detachment')) {
    dets.forEach((d) => {
      const id = String(d._id);
      push(score(d.name, [d.region, d.mainCenter]), {
        type: 'detachment',
        id,
        title: d.name,
        subtitle: joinDot(d.region, d.mainCenter),
        detachmentId: id,
        target: { type: 'detachment', detachmentId: id },
      });
    });
  }

  if (detIds.length && types.has('member')) {
    const memberDets = detIds.filter((id) => caps.canIn(req.grant, id, 'member.view'));
    if (memberDets.length) {
      const members = await TeamMember.find({ tenantId: req.tenantId, detachmentId: { $in: memberDets }, active: true })
        .select('name department personalNumber detachmentId')
        .lean();
      members.forEach((m) => {
        const id = String(m._id);
        push(score(m.name, [m.department, m.personalNumber]), {
          type: 'member',
          id,
          title: m.name,
          subtitle: joinDot(m.department || m.personalNumber, detName.get(m.detachmentId)),
          detachmentId: m.detachmentId,
          target: { type: 'member', detachmentId: m.detachmentId, memberId: id },
        });
      });
    }
  }

  if (detIds.length && types.has('shift')) {
    const weekStart = weekStartOf(todayIn(req.tz));
    const shifts = await Shift.find({
      tenantId: req.tenantId,
      detachmentId: { $in: detIds },
      date: { $gte: addDays(weekStart, -7), $lte: addDays(weekStart, 20) },
    })
      .select('centerName date startMinutes endMinutes detachmentId')
      .lean();
    shifts.forEach((s) => {
      const id = String(s._id);
      push(score(s.centerName), {
        type: 'shift',
        id,
        title: s.centerName,
        subtitle: joinDot(`${s.date} ${hhmm(s.startMinutes)}–${hhmm(s.endMinutes)}`, detName.get(s.detachmentId)),
        detachmentId: s.detachmentId,
        target: { type: 'shift', detachmentId: s.detachmentId, shiftId: id },
      });
    });
  }

  if (detIds.length && types.has('item') && req.tenant.featureEnabled('inventory')) {
    const items = await InventoryItem.find({ tenantId: req.tenantId, detachmentId: { $in: detIds } })
      .select('name unit currentStock detachmentId')
      .lean();
    items.forEach((i) => {
      const id = String(i._id);
      push(score(i.name, [i.unit]), {
        type: 'item',
        id,
        title: i.name,
        subtitle: joinDot(`${i.currentStock} ${i.unit}`, detName.get(i.detachmentId)),
        detachmentId: i.detachmentId,
        target: { type: 'storage', detachmentId: i.detachmentId, itemId: id },
      });
    });
  }

  hits.sort(
    (a, b) =>
      a.s - b.s ||
      TYPE_ORDER.get(a.row.type) - TYPE_ORDER.get(b.row.type) ||
      a.row.title.localeCompare(b.row.title, 'ar') ||
      a.row.id.localeCompare(b.row.id),
  );
  res.json({ query: q, results: hits.slice(0, limit).map((h) => h.row) });
});
