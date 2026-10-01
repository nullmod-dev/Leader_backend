/**
 * Shift domain rules (mock_shift_repository.dart, reproduced server-side).
 *
 *  - `startsAt`/`endsAt` are ALWAYS recomputed from date + minutes in the
 *    tenant timezone (utils/time.shiftWindow) — never trusted from a client.
 *  - Dedupe guard: materializing or copying never stacks a second shift of
 *    the same detachment on the same day at the same `startMinutes`.
 *  - Template reconciliation: a missing day is materialized; a surplus EMPTY
 *    shift is deleted; a surplus STAFFED shift is kept and its day folded back
 *    into the template's settled day set.
 *  - Overlap: a member cannot hold two shifts of the same tenant whose real
 *    [startsAt, endsAt) ranges intersect.
 *
 * Every Shift JSON leaving this module is `serializers.shift` plus
 * `attendanceClosesAt` (= endsAt + settings.attendanceGraceMinutes).
 */
const mongoose = require('mongoose');
const { Shift, ShiftTemplate, TeamMember } = require('../models');
const serializers = require('./serializers');
const settingsService = require('./settingsService');
const { withTransaction } = require('./txn');
const { staleWrite, saveVersioned } = require('./versioning');
const AppError = require('../utils/appError');
const { TEAM_ROLES } = require('../config/constants');
const { shiftWindow, iso, addMinutes, addDays, diffDays } = require('../utils/time');

// ---- serialization ------------------------------------------------------------

const graceMinutes = async () => {
  const s = await settingsService.get();
  return Number.isFinite(s.attendanceGraceMinutes) ? s.attendanceGraceMinutes : 60;
};

/** The instant the ordinary attendance window closes. */
const closesAt = (shift, grace) => addMinutes(shift.endsAt, grace);

const decorate = (json, shift, grace) => {
  const out = { ...json, attendanceClosesAt: iso(closesAt(shift, grace)) };
  if (out.corrections && shift.corrections) {
    const client = new Map(shift.corrections.map((c) => [c._id, c.clientCorrectedAt]));
    out.corrections = out.corrections.map((c) => (client.get(c.id) ? { ...c, clientCorrectedAt: iso(client.get(c.id)) } : c));
  }
  return out;
};

/**
 * A synchronous serializer bound to one member lookup + the current grace —
 * what `assertVersion`/`saveVersioned` need for `currentRecord`.
 */
const serializerFor = async (req, list) => {
  const grace = await graceMinutes();
  const members = await serializers.memberMap(
    req.tenantId,
    list.flatMap((s) => (s.attendees || []).map((a) => a.memberId)),
  );
  return (s) => decorate(serializers.shift(s, members, { grant: req.grant }), s, grace);
};

const toJson = async (req, shift) => (await serializerFor(req, [shift]))(shift);

const toJsonMany = async (req, list) => {
  const ser = await serializerFor(req, list);
  return list.map(ser);
};

/** Corrections as the wire reads them (append order). */
const correctionsJson = (shift) => {
  const json = decorate(serializers.shift(shift, new Map()), shift, 0);
  return json.corrections || [];
};

// ---- building blocks ------------------------------------------------------------

const ORDER = { date: 1, startMinutes: 1, _id: 1 };

const applyWindow = (shift, tz) => {
  const { startsAt, endsAt } = shiftWindow(shift.date, shift.startMinutes, shift.endMinutes, tz);
  shift.startsAt = startsAt;
  shift.endsAt = endsAt;
  return shift;
};

const buildShift = (fields, tz) =>
  applyWindow(
    new Shift({
      tenantId: fields.tenantId,
      detachmentId: fields.detachmentId,
      templateId: fields.templateId || null,
      date: fields.date,
      centerName: fields.centerName,
      startMinutes: fields.startMinutes,
      endMinutes: fields.endMinutes,
      needed: fields.needed,
      attendees: [],
    }),
    tz,
  );

/** True when the detachment already has a shift on `day` starting at `startMinutes`. */
const existsAt = async (tenantId, detachmentId, day, startMinutes, session) =>
  !!(await Shift.exists({ tenantId, detachmentId, date: day, startMinutes }).session(session || null));

const specOf = (s) => ({ centerName: s.centerName, startMinutes: s.startMinutes, endMinutes: s.endMinutes, needed: s.needed });

const assertTimes = (startMinutes, endMinutes) => {
  if (startMinutes === endMinutes) {
    throw AppError.validation({ endMinutes: 'The end time must differ from the start time.' });
  }
};

// ---- reads ----------------------------------------------------------------------

const listForDays = (tenantId, detachmentId, from, to) =>
  Shift.find({ tenantId, detachmentId, date: { $gte: from, $lte: to } }).sort(ORDER);

/** Week header numbers: assigned is capped at needed per shift, as the roll-ups do. */
const weekSummary = (list) => {
  const needed = list.reduce((n, s) => n + s.needed, 0);
  const assigned = list.reduce((n, s) => n + Math.min(s.attendees.length, s.needed), 0);
  const gaps = list.reduce((n, s) => n + Math.max(0, s.needed - s.attendees.length), 0);
  return {
    shiftCount: list.length,
    needed,
    assigned,
    coveragePercent: needed > 0 ? Math.min(100, Math.round((assigned / needed) * 100)) : 0,
    gaps,
  };
};

// ---- create / repeat ------------------------------------------------------------------

/**
 * Create a shift (and, when the repeat set has more than one day, its
 * template + one shift per day). Returns `{ anchor, template }`.
 * The anchor (the shift on `date`) is always created; the other days skip a
 * day+start that is already taken.
 */
const createShifts = async ({ tenantId, tz, detachmentId, date, spec, repeatOn = [] }) => {
  assertTimes(spec.startMinutes, spec.endMinutes);
  const days = [...new Set([date, ...repeatOn])];
  return withTransaction(async (session) => {
    let template = null;
    if (days.length > 1) {
      template = new ShiftTemplate({ tenantId, detachmentId, ...spec, dates: [...days].sort(), active: true });
      await template.save({ session });
    }
    const templateId = template ? String(template._id) : null;
    const anchor = buildShift({ tenantId, detachmentId, templateId, date, ...spec }, tz);
    await anchor.save({ session });
    for (const d of days) {
      if (d === date) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await existsAt(tenantId, detachmentId, d, spec.startMinutes, session)) continue;
      // eslint-disable-next-line no-await-in-loop
      await buildShift({ tenantId, detachmentId, templateId, date: d, ...spec }, tz).save({ session });
    }
    return { anchor, template };
  });
};

/**
 * Bring the shifts of `template` in line with `wanted` (a set of days).
 * Returns `{ settled, created, removed, kept }` — settled is the sorted day
 * set that actually survived; `kept` lists the surplus shifts that were NOT
 * removed because somebody is assigned to them.
 */
const reconcile = async ({ tenantId, tz, template, wanted, spec, session }) => {
  const settled = new Set(wanted);
  const created = [];
  const removed = [];
  const kept = [];
  const mine = await Shift.find({ tenantId, templateId: String(template._id) }).sort(ORDER).session(session || null);
  const present = new Set();
  for (const s of mine) {
    if (settled.has(s.date)) {
      present.add(s.date);
      continue;
    }
    if (s.attendees.length) {
      settled.add(s.date);
      present.add(s.date);
      kept.push(String(s._id));
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await s.deleteOne({ session });
    removed.push(String(s._id));
  }
  for (const day of [...settled].sort()) {
    if (present.has(day)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await existsAt(tenantId, template.detachmentId, day, spec.startMinutes, session)) continue;
    const s = buildShift({ tenantId, detachmentId: template.detachmentId, templateId: String(template._id), date: day, ...spec }, tz);
    // eslint-disable-next-line no-await-in-loop
    await s.save({ session });
    present.add(day);
    created.push(String(s._id));
  }
  return { settled: [...settled].sort(), created, removed, kept };
};

/**
 * PUT /shifts/:id/repeat — the anchor's repeat set becomes {anchor.date} ∪ dates.
 * Creates the template when the shift has none; the template mirrors the
 * anchor's current spec. Returns `{ template, shifts }`.
 */
const updateRepeat = async ({ tenantId, tz, shiftId, dates }) =>
  withTransaction(async (session) => {
    const anchor = await Shift.findOne({ _id: shiftId, tenantId }).session(session || null);
    if (!anchor) throw AppError.notFound('shift');
    const wanted = new Set([anchor.date, ...dates]);
    let template = anchor.templateId
      ? await ShiftTemplate.findOne({ _id: anchor.templateId, tenantId }).session(session || null)
      : null;
    if (!template) {
      template = new ShiftTemplate({
        tenantId,
        detachmentId: anchor.detachmentId,
        ...specOf(anchor),
        dates: [...wanted].sort(),
        active: wanted.size > 1,
      });
      await template.save({ session });
      anchor.templateId = String(template._id);
      await anchor.save({ session });
    }
    const result = await reconcile({ tenantId, tz, template, wanted, spec: specOf(anchor), session });
    Object.assign(template, specOf(anchor));
    template.dates = result.settled;
    template.active = result.settled.length > 1;
    await template.save({ session });
    const shifts = await Shift.find({ tenantId, templateId: String(template._id) }).sort(ORDER).session(session || null);
    return { template, shifts, ...result };
  });

/** PUT /shift-templates/:id/dates. Only the day set moves; the template's own spec is the truth. */
const updateTemplateDates = async ({ tenantId, tz, template, dates, version, serialize }) =>
  withTransaction(async (session) => {
    const t = await ShiftTemplate.findOne({ _id: template._id, tenantId }).session(session || null);
    if (!t) throw AppError.notFound('template');
    if (version !== undefined && version !== null && t.version !== Number(version)) throw staleWrite(t, serialize);
    const result = await reconcile({ tenantId, tz, template: t, wanted: new Set(dates), spec: specOf(t), session });
    t.dates = result.settled;
    t.active = result.settled.length > 1;
    await t.save({ session });
    return { template: t, ...result };
  });

// ---- copy -------------------------------------------------------------------------------

/**
 * Clone `source` onto the day `dayFor(shift)` returns — without attendees and
 * without templateId, skipping a day+start that is already taken.
 */
const cloneOnto = async ({ tenantId, tz, detachmentId, source, dayFor }) =>
  withTransaction(async (session) => {
    let created = 0;
    for (const s of source) {
      const day = dayFor(s);
      // eslint-disable-next-line no-await-in-loop
      if (await existsAt(tenantId, detachmentId, day, s.startMinutes, session)) continue;
      // eslint-disable-next-line no-await-in-loop
      await buildShift({ tenantId, detachmentId, templateId: null, date: day, ...specOf(s) }, tz).save({ session });
      created += 1;
    }
    return created;
  });

const copyDay = async ({ tenantId, tz, detachmentId, fromDay, toDay }) => {
  if (fromDay === toDay) throw AppError.validation({ toDay: 'A day cannot be copied onto itself.' });
  const source = await Shift.find({ tenantId, detachmentId, date: fromDay }).sort(ORDER);
  return cloneOnto({ tenantId, tz, detachmentId, source, dayFor: () => toDay });
};

const copyWeek = async ({ tenantId, tz, detachmentId, fromWeekStart, toWeekStart }) => {
  if (fromWeekStart === toWeekStart) throw AppError.validation({ toWeekStart: 'A week cannot be copied onto itself.' });
  const source = await listForDays(tenantId, detachmentId, fromWeekStart, addDays(fromWeekStart, 6));
  return cloneOnto({
    tenantId,
    tz,
    detachmentId,
    source,
    // Calendar arithmetic on both halves (never 24-hour spans).
    dayFor: (s) => addDays(toWeekStart, diffDays(fromWeekStart, s.date)),
  });
};

// ---- assignment ---------------------------------------------------------------------------

/** Shifts of the tenant (other than `shift`) whose real range intersects `shift`'s. */
const overlapFilter = (tenantId, shift) => ({
  tenantId,
  _id: { $ne: String(shift._id) },
  startsAt: { $lt: shift.endsAt },
  endsAt: { $gt: shift.startsAt },
});

const clashFor = (tenantId, memberId, shift) =>
  Shift.findOne({ ...overlapFilter(tenantId, shift), 'attendees.memberId': memberId }).sort({ startsAt: 1, _id: 1 });

/** Map<memberId, clashing Shift> for many members at once. */
const clashesFor = async (tenantId, memberIds, shift) => {
  const out = new Map();
  if (!memberIds.length) return out;
  const list = await Shift.find({ ...overlapFilter(tenantId, shift), 'attendees.memberId': { $in: memberIds } }).sort({ startsAt: 1, _id: 1 });
  const wanted = new Set(memberIds);
  list.forEach((s) => {
    s.attendees.forEach((a) => {
      if (wanted.has(a.memberId) && !out.has(a.memberId)) out.set(a.memberId, s);
    });
  });
  return out;
};

const busyWithJson = (s) => ({
  shiftId: String(s._id),
  detachmentId: s.detachmentId,
  centerName: s.centerName,
  date: s.date,
  startMinutes: s.startMinutes,
  endMinutes: s.endMinutes,
});

/**
 * Validate that `memberId` may be added to `shift` (mutates nothing).
 * Order: unknown → other detachment → inactive → already assigned → overlap.
 */
const assertAssignable = async (tenantId, shift, memberId) => {
  const member = await TeamMember.findOne({ _id: memberId, tenantId });
  if (!member) throw AppError.notFound('member');
  if (member.detachmentId !== shift.detachmentId) {
    throw AppError.validation({ memberId: 'The member belongs to another detachment.' });
  }
  if (member.active === false) throw AppError.validation({ memberId: 'The member is inactive.' });
  if (shift.attendees.some((a) => a.memberId === memberId)) {
    throw AppError.conflict('The member is already assigned to this shift.');
  }
  const clash = await clashFor(tenantId, memberId, shift);
  if (clash) {
    throw AppError.conflict('The member is assigned to another shift that overlaps this one.', {
      reason: 'overlap',
      overlapShiftId: String(clash._id),
    });
  }
  return member;
};

const roleRank = (role) => {
  const i = TEAM_ROLES.indexOf(role);
  return i < 0 ? TEAM_ROLES.length : i;
};

/**
 * Active members of the shift's detachment not already on it:
 * free first, then role order, then name.
 */
const candidates = async (tenantId, shift) => {
  const already = new Set(shift.attendees.map((a) => a.memberId));
  const members = (await TeamMember.find({ tenantId, detachmentId: shift.detachmentId, active: true })).filter(
    (m) => !already.has(String(m._id)),
  );
  const clashes = await clashesFor(tenantId, members.map((m) => String(m._id)), shift);
  const rows = members.map((m) => ({ member: m, busyWith: clashes.get(String(m._id)) || null }));
  rows.sort((a, b) => {
    if (!!a.busyWith !== !!b.busyWith) return a.busyWith ? 1 : -1;
    const r = roleRank(a.member.role) - roleRank(b.member.role);
    if (r) return r;
    return a.member.name.localeCompare(b.member.name, 'ar');
  });
  return rows;
};

const candidatesJson = (rows, grant) =>
  rows.map((r) => {
    const out = { member: serializers.member(r.member, { grant }), busy: !!r.busyWith };
    if (r.busyWith) out.busyWith = busyWithJson(r.busyWith);
    return out;
  });

// ---- command writes (no client version) ---------------------------------------------------

/**
 * A conditional save that lost: our `version` guard (DocumentNotFoundError)
 * or Mongoose's own `__v` array guard (VersionError — raised when an array
 * such as `attendees` changed underneath us).
 */
const isLostRace = (err) => err instanceof mongoose.Error.DocumentNotFoundError || err instanceof mongoose.Error.VersionError;

/** `saveVersioned`, also turning a Mongoose VersionError into 409 stale_write. */
const saveOrStale = async (doc, serialize, options = {}) => {
  try {
    return await saveVersioned(doc, serialize, options);
  } catch (err) {
    if (!(err instanceof mongoose.Error.VersionError)) throw err;
    const current = await doc.constructor.findById(doc._id);
    throw staleWrite(current, serialize);
  }
};

/**
 * Run `apply(shift)` then save. A lost race (another writer bumped the
 * version) reloads the shift and re-applies — the rules are re-validated on
 * the fresh state — up to three attempts, then 409 stale_write.
 */
const mutate = async (req, apply) => {
  let doc = req.docs.shift;
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await apply(doc);
    try {
      // eslint-disable-next-line no-await-in-loop
      await doc.save();
      return { shift: doc, result };
    } catch (err) {
      if (!isLostRace(err)) throw err;
      // eslint-disable-next-line no-await-in-loop
      const fresh = await Shift.findOne({ _id: doc._id, tenantId: req.tenantId });
      if (!fresh) throw AppError.notFound('shift');
      if (attempt >= 2) {
        // eslint-disable-next-line no-await-in-loop
        throw staleWrite(fresh, await serializerFor(req, [fresh]));
      }
      doc = fresh;
    }
  }
};

module.exports = {
  graceMinutes,
  closesAt,
  serializerFor,
  toJson,
  toJsonMany,
  correctionsJson,
  applyWindow,
  assertTimes,
  existsAt,
  listForDays,
  weekSummary,
  createShifts,
  reconcile,
  updateRepeat,
  updateTemplateDates,
  copyDay,
  copyWeek,
  clashFor,
  clashesFor,
  assertAssignable,
  candidates,
  candidatesJson,
  isLostRace,
  saveOrStale,
  mutate,
  ORDER,
};
