/**
 * Tenant analytics (/tenant/analytics/**) — read-only figures derived from the
 * operational records on every request (nothing is pre-aggregated, so a
 * figure can never disagree with the list behind it).
 *
 * SCOPE: every figure covers only the detachments where the caller holds
 * `stats.view` (`caps.detachmentsWith(grant, 'stats.view')`; `null` = every
 * ACTIVE detachment of the tenant). Workshops are organisation-level and are
 * not detachment-scoped.
 *
 * DAYS are tenant-local (`req.tz`). A range is `from`..`to` inclusive
 * (YYYY-MM-DD), default the last 30 days ending today, at most 366 days.
 *
 * FORMULAS (docs/api/tenant-analytics.md):
 *   coveragePercent   = round(Σ min(assigned, needed) / Σ needed × 100), 0 when Σ needed = 0
 *   attendancePercent = round(present / resolved × 100), 0 when resolved = 0
 *                       present  = checkedIn + checkedOut
 *                       resolved = checkedIn + checkedOut + absent
 *   pending           = notCheckedIn rows of shifts that have already ENDED
 */
const { DateTime } = require('luxon');
const {
  Detachment,
  TeamMember,
  Shift,
  InventoryItem,
  InventoryMovement,
  Workshop,
  WorkshopParticipant,
  Announcement,
} = require('../models');
const AppError = require('../utils/appError');
const caps = require('../config/capabilities');
const { EXPIRING_SOON_DAYS, WORKSHOP_STATUS } = require('../config/constants');
const { parseDay, todayIn, addDays, diffDays, eachDay, dayOf } = require('../utils/time');
const { missingMember } = require('./serializers');

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const TOP_MEMBERS = 10;

// ---- range + scope -----------------------------------------------------------------------

/** { from, to } from the query (422 validation on a bad or oversized range). */
const resolveRange = (query = {}, tz) => {
  const fields = {};
  const has = (k) => query[k] !== undefined && query[k] !== null && query[k] !== '';
  const to = has('to') ? parseDay(String(query.to)) : todayIn(tz);
  if (!to) fields.to = 'to must be a calendar day (YYYY-MM-DD).';
  let from = has('from') ? parseDay(String(query.from)) : null;
  if (has('from') && !from) fields.from = 'from must be a calendar day (YYYY-MM-DD).';
  if (!has('from') && to) from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from && to) {
    if (from > to) fields.from = 'from must be on or before to.';
    else if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) fields.range = `The range cannot exceed ${MAX_RANGE_DAYS} days.`;
  }
  if (Object.keys(fields).length) throw AppError.validation(fields);
  return { from, to };
};

/** UTC instants bounding the tenant-local range: [start of from, start of to+1). */
const rangeInstants = ({ from, to }, tz) => ({
  start: DateTime.fromISO(from, { zone: tz }).startOf('day').toJSDate(),
  end: DateTime.fromISO(addDays(to, 1), { zone: tz }).startOf('day').toJSDate(),
});

/** Detachments the caller may see statistics for (active ones when held globally). */
const scopedDetachments = async (tenantId, grant) => {
  const ids = caps.detachmentsWith(grant, 'stats.view');
  const filter = { tenantId, status: 'active' };
  if (ids !== null) filter._id = { $in: ids };
  return Detachment.find(filter).select('_id name detachmentGroupId status').sort({ name: 1 }).lean();
};

// ---- tallies --------------------------------------------------------------------------------

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

const blankTally = () => ({ shifts: 0, needed: 0, filled: 0, checkedIn: 0, checkedOut: 0, absent: 0, pending: 0 });

const addShift = (t, s, now) => {
  const attendees = s.attendees || [];
  t.shifts += 1;
  t.needed += s.needed;
  t.filled += Math.min(attendees.length, s.needed);
  attendees.forEach((a) => {
    if (a.attendance === 'checkedIn') t.checkedIn += 1;
    else if (a.attendance === 'checkedOut') t.checkedOut += 1;
    else if (a.attendance === 'absent') t.absent += 1;
    else if (s.endsAt && new Date(s.endsAt) < now) t.pending += 1;
  });
};

const coverageOf = (t) => Math.min(100, pct(t.filled, t.needed));
const presentOf = (t) => t.checkedIn + t.checkedOut;
const attendanceOf = (t) => pct(presentOf(t), presentOf(t) + t.absent);

const tallyShifts = (shifts, now, keyOf) => {
  const map = new Map();
  shifts.forEach((s) => {
    const k = keyOf(s);
    if (!map.has(k)) map.set(k, blankTally());
    addShift(map.get(k), s, now);
  });
  return map;
};

const totalOf = (shifts, now) => {
  const t = blankTally();
  shifts.forEach((s) => addShift(t, s, now));
  return t;
};

/** Per-member attendance across shifts. */
const memberTallies = (shifts, now) => {
  const map = new Map();
  shifts.forEach((s) => {
    const ended = s.endsAt && new Date(s.endsAt) < now;
    (s.attendees || []).forEach((a) => {
      const id = String(a.memberId);
      if (!map.has(id)) map.set(id, { memberId: id, detachmentId: s.detachmentId, shifts: 0, attended: 0, absent: 0, pending: 0 });
      const m = map.get(id);
      m.shifts += 1;
      if (a.attendance === 'checkedIn' || a.attendance === 'checkedOut') m.attended += 1;
      else if (a.attendance === 'absent') m.absent += 1;
      else if (ended) m.pending += 1;
    });
  });
  return map;
};

const dailySeries = (range, byDay) =>
  eachDay(range.from, range.to).map((date) => {
    const t = byDay.get(date) || blankTally();
    return { date, coverage: coverageOf(t), attendance: attendanceOf(t) };
  });

// ---- inventory helpers ------------------------------------------------------------------------

/** Worst-wins storage verdict (storage_status.dart storageStatusOf). */
const storageStatusOf = (items, today) => {
  if (!items.length) return 'empty';
  let anyLow = false;
  let anyExpiring = false;
  for (const i of items) {
    if (i.level === 'empty') return 'depleted';
    if (i.level === 'low') anyLow = true;
    if (i.expiresOn && diffDays(today, i.expiresOn) <= EXPIRING_SOON_DAYS) anyExpiring = true;
  }
  if (anyLow) return 'low';
  if (anyExpiring) return 'expiring';
  return 'healthy';
};

const isExpiring = (item, today) => !!item.expiresOn && diffDays(today, item.expiresOn) <= EXPIRING_SOON_DAYS;

/** Daily inflow/outflow in BASE units over the range. */
const movementSeries = async (tenantId, detachmentIds, range, tz) => {
  const { start, end } = rangeInstants(range, tz);
  const rows = await InventoryMovement.find({ tenantId, detachmentId: { $in: detachmentIds }, at: { $gte: start, $lt: end } })
    .select('direction convertedBaseUnitQuantity at')
    .lean();
  const byDay = new Map();
  rows.forEach((mv) => {
    const day = dayOf(mv.at, tz);
    if (!byDay.has(day)) byDay.set(day, { inflow: 0, outflow: 0 });
    byDay.get(day)[mv.direction === 'inflow' ? 'inflow' : 'outflow'] += mv.convertedBaseUnitQuantity || 0;
  });
  return eachDay(range.from, range.to).map((date) => ({ date, ...(byDay.get(date) || { inflow: 0, outflow: 0 }) }));
};

const loadShifts = (tenantId, detachmentIds, range) =>
  Shift.find({ tenantId, detachmentId: { $in: detachmentIds }, date: { $gte: range.from, $lte: range.to } })
    .select('detachmentId date centerName needed attendees endsAt')
    .lean();

const activeAnnouncements = (tenantId, detachmentIds, now) =>
  Announcement.countDocuments({
    tenantId,
    status: 'active',
    publishedAt: { $lte: now },
    expiresAt: { $gt: now },
    detachmentIds: { $in: detachmentIds },
  });

/** Workshops (not archived) whose `at` falls in the range + their registers. */
const workshopsInRange = async (tenantId, range, tz) => {
  const { start, end } = rangeInstants(range, tz);
  const workshops = await Workshop.find({ tenantId, archived: { $ne: true }, at: { $gte: start, $lt: end } })
    .select('status at registrationFee')
    .lean();
  const participants = workshops.length
    ? await WorkshopParticipant.find({ tenantId, workshopId: { $in: workshops.map((w) => String(w._id)) } })
        .select('workshopId attendance paymentStatus')
        .lean()
    : [];
  return { workshops, participants };
};

const attendanceOfRows = (rows) => {
  let present = 0;
  let resolved = 0;
  rows.forEach((r) => {
    if (r.attendance === 'checkedIn' || r.attendance === 'checkedOut') {
      present += 1;
      resolved += 1;
    } else if (r.attendance === 'absent') resolved += 1;
  });
  return pct(present, resolved);
};

const nameMap = async (tenantId, ids) => {
  if (!ids.length) return new Map();
  const docs = await TeamMember.find({ tenantId, _id: { $in: ids } }).select('name role detachmentId active').lean();
  return new Map(docs.map((d) => [String(d._id), d]));
};

// ---- reports ------------------------------------------------------------------------------------

/**
 * GET /tenant/analytics/dashboard
 * @param ctx { tenant, grant, tz, query, now? }
 */
const dashboard = async ({ tenant, grant, tz, query, now = new Date() }) => {
  const range = resolveRange(query, tz);
  const tenantId = String(tenant._id);
  const today = todayIn(tz, now);
  const dets = await scopedDetachments(tenantId, grant);
  const detIds = dets.map((d) => String(d._id));
  const inventoryOn = tenant.featureEnabled('inventory');
  const workshopsOn = tenant.featureEnabled('workshops');
  const announcementsOn = tenant.featureEnabled('announcements');

  const [shifts, memberRows, items] = await Promise.all([
    loadShifts(tenantId, detIds, range),
    TeamMember.aggregate([
      { $match: { tenantId, detachmentId: { $in: detIds }, active: true } },
      { $group: { _id: '$detachmentId', n: { $sum: 1 } } },
    ]),
    inventoryOn
      ? InventoryItem.find({ tenantId, detachmentId: { $in: detIds } }).select('detachmentId level expiresOn').lean()
      : Promise.resolve([]),
  ]);

  const total = totalOf(shifts, now);
  const membersByDet = new Map(memberRows.map((r) => [r._id, r.n]));
  const kpis = {
    detachments: dets.length,
    members: memberRows.reduce((a, r) => a + r.n, 0),
    shifts: total.shifts,
    neededSlots: total.needed,
    filledSlots: total.filled,
    coveragePercent: coverageOf(total),
    attendancePercent: attendanceOf(total),
    absences: total.absent,
  };

  if (workshopsOn) {
    const { workshops, participants } = await workshopsInRange(tenantId, range, tz);
    kpis.workshops = workshops.length;
    kpis.workshopAttendancePercent = attendanceOfRows(participants);
  }
  if (inventoryOn) {
    kpis.lowStockItems = items.filter((i) => i.level !== 'ok').length;
    kpis.expiringItems = items.filter((i) => isExpiring(i, today)).length;
  }
  if (announcementsOn) kpis.activeAnnouncements = await activeAnnouncements(tenantId, detIds, now);

  const daily = dailySeries(range, tallyShifts(shifts, now, (s) => s.date));
  const series = {
    coverage: daily.map((d) => ({ date: d.date, percent: d.coverage })),
    attendance: daily.map((d) => ({ date: d.date, percent: d.attendance })),
  };
  if (inventoryOn) series.stockMovements = await movementSeries(tenantId, detIds, range, tz);

  const byDetTally = tallyShifts(shifts, now, (s) => s.detachmentId);
  const itemsByDet = new Map();
  items.forEach((i) => {
    if (!itemsByDet.has(i.detachmentId)) itemsByDet.set(i.detachmentId, []);
    itemsByDet.get(i.detachmentId).push(i);
  });
  const byDetachment = dets.map((d) => {
    const id = String(d._id);
    const t = byDetTally.get(id) || blankTally();
    const row = {
      detachmentId: id,
      name: d.name,
      shifts: t.shifts,
      coveragePercent: coverageOf(t),
      attendancePercent: attendanceOf(t),
      members: membersByDet.get(id) || 0,
    };
    if (inventoryOn) row.storageStatus = storageStatusOf(itemsByDet.get(id) || [], today);
    return row;
  });

  const tallies = [...memberTallies(shifts, now).values()];
  const names = await nameMap(tenantId, tallies.map((m) => m.memberId));
  const topMembers = tallies
    .map((m) => {
      const doc = names.get(m.memberId);
      return {
        memberId: m.memberId,
        name: doc ? doc.name : missingMember(m.memberId).name,
        detachmentId: doc ? doc.detachmentId : m.detachmentId,
        attended: m.attended,
        absent: m.absent,
        attendancePercent: pct(m.attended, m.attended + m.absent),
      };
    })
    .sort((a, b) => b.attended - a.attended || b.attendancePercent - a.attendancePercent || a.name.localeCompare(b.name))
    .slice(0, TOP_MEMBERS);

  return { range, generatedAt: now.toISOString(), kpis, series, byDetachment, topMembers };
};

/**
 * GET /tenant/analytics/detachments/:detachmentId
 * @param ctx { tenant, tz, detachment (doc), query, now? }
 */
const detachmentReport = async ({ tenant, tz, detachment, query, now = new Date() }) => {
  const range = resolveRange(query, tz);
  const tenantId = String(tenant._id);
  const today = todayIn(tz, now);
  const detId = String(detachment._id);
  const inventoryOn = tenant.featureEnabled('inventory');
  const announcementsOn = tenant.featureEnabled('announcements');

  const [shifts, roster, items] = await Promise.all([
    loadShifts(tenantId, [detId], range),
    TeamMember.find({ tenantId, detachmentId: detId, active: true }).select('name role').lean(),
    inventoryOn ? InventoryItem.find({ tenantId, detachmentId: detId }).select('level expiresOn').lean() : Promise.resolve([]),
  ]);

  const total = totalOf(shifts, now);
  const kpis = {
    members: roster.length,
    shifts: total.shifts,
    neededSlots: total.needed,
    filledSlots: total.filled,
    coveragePercent: coverageOf(total),
    attendancePercent: attendanceOf(total),
    absences: total.absent,
  };
  if (inventoryOn) {
    kpis.lowStockItems = items.filter((i) => i.level !== 'ok').length;
    kpis.expiringItems = items.filter((i) => isExpiring(i, today)).length;
    kpis.storageStatus = storageStatusOf(items, today);
  }
  if (announcementsOn) kpis.activeAnnouncements = await activeAnnouncements(tenantId, [detId], now);

  const daily = dailySeries(range, tallyShifts(shifts, now, (s) => s.date));
  const series = {
    coverage: daily.map((d) => ({ date: d.date, percent: d.coverage })),
    attendance: daily.map((d) => ({ date: d.date, percent: d.attendance })),
  };
  if (inventoryOn) series.stockMovements = await movementSeries(tenantId, [detId], range, tz);

  // Everyone on the active roster, plus anyone who worked a shift in range.
  const tallies = memberTallies(shifts, now);
  roster.forEach((m) => {
    const id = String(m._id);
    if (!tallies.has(id)) tallies.set(id, { memberId: id, detachmentId: detId, shifts: 0, attended: 0, absent: 0, pending: 0 });
  });
  const names = await nameMap(tenantId, [...tallies.keys()]);
  const members = [...tallies.values()]
    .map((m) => {
      const doc = names.get(m.memberId);
      return {
        memberId: m.memberId,
        name: doc ? doc.name : missingMember(m.memberId).name,
        role: doc ? doc.role : 'member',
        shifts: m.shifts,
        attended: m.attended,
        absent: m.absent,
        pending: m.pending,
        attendancePercent: pct(m.attended, m.attended + m.absent),
      };
    })
    .sort((a, b) => b.attended - a.attended || b.shifts - a.shifts || a.name.localeCompare(b.name));

  const centers = [...tallyShifts(shifts, now, (s) => s.centerName).entries()]
    .map(([centerName, t]) => ({ centerName, shifts: t.shifts, coveragePercent: coverageOf(t) }))
    .sort((a, b) => b.shifts - a.shifts || a.centerName.localeCompare(b.centerName));

  return {
    detachment: { id: detId, name: detachment.name },
    range,
    generatedAt: now.toISOString(),
    kpis,
    series,
    members,
    centers,
  };
};

/**
 * GET /tenant/analytics/workshops
 * @param ctx { tenant, tz, query }
 */
const workshopsReport = async ({ tenant, tz, query, now = new Date() }) => {
  const range = resolveRange(query, tz);
  const tenantId = String(tenant._id);
  const { workshops, participants } = await workshopsInRange(tenantId, range, tz);

  const byStatus = Object.fromEntries(WORKSHOP_STATUS.map((s) => [s, 0]));
  workshops.forEach((w) => {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1;
  });

  const feeOf = new Map(workshops.map((w) => [String(w._id), w.registrationFee || 0]));
  const payments = { paid: 0, unpaid: 0, totalCollected: 0 };
  participants.forEach((p) => {
    const fee = feeOf.get(p.workshopId) || 0;
    if (fee <= 0) return; // a free workshop has nothing to pay
    if (p.paymentStatus === 'paid') {
      payments.paid += 1;
      payments.totalCollected += fee;
    } else payments.unpaid += 1;
  });

  // Every month the range touches, in order, zeros included.
  const months = [];
  let cursor = DateTime.fromISO(range.from).startOf('month');
  const last = DateTime.fromISO(range.to).startOf('month');
  while (cursor <= last) {
    months.push(cursor.toFormat('yyyy-MM'));
    cursor = cursor.plus({ months: 1 });
  }
  const perWorkshop = new Map();
  participants.forEach((p) => perWorkshop.set(p.workshopId, (perWorkshop.get(p.workshopId) || 0) + 1));
  const monthly = new Map(months.map((m) => [m, { month: m, workshops: 0, participants: 0 }]));
  workshops.forEach((w) => {
    const m = DateTime.fromJSDate(w.at).setZone(tz).toFormat('yyyy-MM');
    const row = monthly.get(m);
    if (!row) return;
    row.workshops += 1;
    row.participants += perWorkshop.get(String(w._id)) || 0;
  });

  return {
    range,
    generatedAt: now.toISOString(),
    count: workshops.length,
    byStatus,
    participants: participants.length,
    attendancePercent: attendanceOfRows(participants),
    payments,
    byMonth: [...monthly.values()],
  };
};

/**
 * GET /tenant/analytics/inventory[?detachmentId]
 * @param ctx { tenant, grant, tz, query, detachmentId? }
 */
const inventoryReport = async ({ tenant, grant, tz, query, now = new Date() }) => {
  const range = resolveRange(query, tz);
  const tenantId = String(tenant._id);
  const today = todayIn(tz, now);

  let detIds;
  if (query.detachmentId) {
    const det = await Detachment.findOne({ _id: String(query.detachmentId), tenantId }).select('_id');
    if (!det) throw AppError.notFound('detachment');
    if (!caps.canIn(grant, String(det._id), 'stats.view')) throw AppError.notPermitted('Requires stats.view in this detachment.');
    detIds = [String(det._id)];
  } else {
    detIds = (await scopedDetachments(tenantId, grant)).map((d) => String(d._id));
  }

  const items = await InventoryItem.find({ tenantId, detachmentId: { $in: detIds } })
    .select('detachmentId name level expiresOn')
    .lean();
  const byLevel = { ok: 0, low: 0, empty: 0 };
  items.forEach((i) => {
    byLevel[i.level] = (byLevel[i.level] || 0) + 1;
  });
  const expiring = items
    .filter((i) => isExpiring(i, today))
    .map((i) => ({
      itemId: String(i._id),
      name: i.name,
      detachmentId: i.detachmentId,
      expiresOn: i.expiresOn,
      daysLeft: diffDays(today, i.expiresOn),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));

  return {
    range,
    generatedAt: now.toISOString(),
    items: items.length,
    byLevel,
    expiring,
    movements: await movementSeries(tenantId, detIds, range, tz),
  };
};

module.exports = {
  MAX_RANGE_DAYS,
  resolveRange,
  scopedDetachments,
  storageStatusOf,
  dashboard,
  detachmentReport,
  workshopsReport,
  inventoryReport,
};
