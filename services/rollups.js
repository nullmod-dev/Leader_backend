/**
 * Derived roll-ups, computed on every read so a card can never disagree with
 * the list behind it.
 *
 * Detachment:
 *   memberCount      — active team members
 *   weeklyShiftCount — shifts dated in the current week (Saturday start, tenant tz)
 *   coveragePercent  — round(Σ assigned / Σ needed × 100) over this week's shifts
 *                      (0 when the week has none), capped at 100
 * DetachmentGroup:
 *   detachmentCount  — detachments in the group (archived included)
 *   memberCount      — Σ memberCount of those detachments (archived included)
 *   coveragePercent  — rounded MEAN coveragePercent over ACTIVE detachments only,
 *                      0 when there are none
 */
const { TeamMember, Shift, Detachment } = require('../models');
const { todayIn, weekStartOf, addDays } = require('../utils/time');

const detachmentRollups = async (tenantId, detachmentIds, tz) => {
  const ids = detachmentIds.map(String);
  if (!ids.length) return new Map();
  const weekStart = weekStartOf(todayIn(tz));
  const weekEnd = addDays(weekStart, 6);

  const [memberRows, shiftRows] = await Promise.all([
    TeamMember.aggregate([
      { $match: { tenantId, detachmentId: { $in: ids }, active: true } },
      { $group: { _id: '$detachmentId', n: { $sum: 1 } } },
    ]),
    Shift.aggregate([
      { $match: { tenantId, detachmentId: { $in: ids }, date: { $gte: weekStart, $lte: weekEnd } } },
      {
        $group: {
          _id: '$detachmentId',
          n: { $sum: 1 },
          needed: { $sum: '$needed' },
          assigned: { $sum: { $min: [{ $size: '$attendees' }, '$needed'] } },
        },
      },
    ]),
  ]);

  const members = new Map(memberRows.map((r) => [r._id, r.n]));
  const shifts = new Map(shiftRows.map((r) => [r._id, r]));
  const out = new Map();
  ids.forEach((id) => {
    const s = shifts.get(id);
    out.set(id, {
      memberCount: members.get(id) || 0,
      weeklyShiftCount: s ? s.n : 0,
      coveragePercent: s && s.needed > 0 ? Math.min(100, Math.round((s.assigned / s.needed) * 100)) : 0,
    });
  });
  return out;
};

/** Roll-ups for groups, derived from their detachments' roll-ups. */
const groupRollups = async (tenantId, groupIds, tz) => {
  const ids = groupIds.map(String);
  if (!ids.length) return new Map();
  const dets = await Detachment.find({ tenantId, detachmentGroupId: { $in: ids } }).select('_id detachmentGroupId status');
  const detRoll = await detachmentRollups(tenantId, dets.map((d) => String(d._id)), tz);
  const out = new Map(ids.map((id) => [id, { detachmentCount: 0, memberCount: 0, coveragePercent: 0, _cov: [] }]));
  dets.forEach((d) => {
    const g = out.get(d.detachmentGroupId);
    if (!g) return;
    const r = detRoll.get(String(d._id));
    g.detachmentCount += 1;
    g.memberCount += r.memberCount;
    if (d.status === 'active') g._cov.push(r.coveragePercent);
  });
  out.forEach((g) => {
    g.coveragePercent = g._cov.length ? Math.round(g._cov.reduce((a, b) => a + b, 0) / g._cov.length) : 0;
    delete g._cov;
  });
  return out;
};

module.exports = { detachmentRollups, groupRollups };
