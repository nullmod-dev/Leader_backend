/**
 * Daily series for the detachment Stats tab (`DetachmentStats`).
 *
 * Every series has one integer per calendar day (tenant timezone), oldest
 * first, ending TODAY. The Flutter model reads the three series keys; `days`,
 * `from`, `to` and `definitions` are additive so a chart can label its axis.
 *
 *   attendanceSeries — % of RESOLVED attendees (checkedIn + checkedOut) over
 *                      (checkedIn + checkedOut + absent), across the shifts
 *                      dated that day; 0 when nobody was resolved
 *   coverageSeries   — round(Σ min(assigned, needed) / Σ needed × 100) across
 *                      the shifts dated that day; 0 when there are none
 *   stockSeries      — inventory movements recorded that day (a COUNT of
 *                      inflows + outflows); all zeros when the inventory
 *                      module is disabled
 */
const { Shift, InventoryMovement } = require('../models');
const { todayIn, addDays, eachDay, dayMinutesToInstant, dayOf } = require('../utils/time');

const DEFINITIONS = Object.freeze({
  attendanceSeries:
    '% of resolved attendees (checkedIn+checkedOut) over (checkedIn+checkedOut+absent) for shifts dated that day; 0 when none resolved',
  coverageSeries: 'round(Σ min(assigned,needed) / Σ needed × 100) for shifts dated that day; 0 when none',
  stockSeries: 'inventory movements recorded that day (count, inflow+outflow)',
});

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.detachmentId
 * @param {string} p.tz
 * @param {number} [p.days=7]              7..90
 * @param {boolean} [p.inventoryEnabled=true]
 * @param {Date}   [p.now]
 */
const forDetachment = async ({ tenantId, detachmentId, tz, days = 7, inventoryEnabled = true, now = new Date() }) => {
  const to = todayIn(tz, now);
  const from = addDays(to, -(days - 1));
  const dayList = eachDay(from, to);
  const index = new Map(dayList.map((d, i) => [d, i]));

  const acc = dayList.map(() => ({ resolved: 0, answered: 0, covered: 0, needed: 0, movements: 0 }));

  const shifts = await Shift.find({ tenantId, detachmentId, date: { $gte: from, $lte: to } })
    .select('date needed attendees.attendance')
    .lean();
  shifts.forEach((s) => {
    const i = index.get(s.date);
    if (i === undefined) return;
    const a = acc[i];
    const attendees = s.attendees || [];
    attendees.forEach((x) => {
      if (x.attendance === 'checkedIn' || x.attendance === 'checkedOut') {
        a.resolved += 1;
        a.answered += 1;
      } else if (x.attendance === 'absent') {
        a.answered += 1;
      }
    });
    a.needed += s.needed || 0;
    a.covered += Math.min(attendees.length, s.needed || 0);
  });

  if (inventoryEnabled) {
    const start = dayMinutesToInstant(from, 0, tz);
    const end = dayMinutesToInstant(addDays(to, 1), 0, tz);
    const movements = await InventoryMovement.find({ tenantId, detachmentId, at: { $gte: start, $lt: end } })
      .select('at')
      .lean();
    movements.forEach((m) => {
      const i = index.get(dayOf(m.at, tz));
      if (i !== undefined) acc[i].movements += 1;
    });
  }

  return {
    attendanceSeries: acc.map((a) => pct(a.resolved, a.answered)),
    coverageSeries: acc.map((a) => Math.min(100, pct(a.covered, a.needed))),
    stockSeries: acc.map((a) => a.movements),
    days: dayList,
    from,
    to,
    definitions: DEFINITIONS,
  };
};

module.exports = { forDetachment, DEFINITIONS };
