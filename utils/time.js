/**
 * Time on the wire has exactly two shapes:
 *
 *  - **calendar days** (`Shift.date`, `ShiftTemplate.dates`, `InventoryItem.expiresOn`)
 *    are `"YYYY-MM-DD"` strings in the TENANT's local calendar. They are never
 *    instants: the Flutter client compares them with `==` against local
 *    midnights, and a `Z` suffix would silently break every same-day match.
 *  - **instants** (`createdAt`, `checkInAt`, `publishedAt`, `expiresAt`, …) are
 *    RFC 3339 UTC strings with `Z` (what `Date#toJSON` produces).
 *
 * Instants the client sends WITHOUT an offset (Dart `toIso8601String()` of a
 * local DateTime) are interpreted in the tenant's timezone.
 */
const { DateTime } = require('luxon');

const DEFAULT_TZ = 'Asia/Damascus';
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?)?$/;
const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** "2026-09-28" | "2026-09-28T00:00:00.000" → "2026-09-28"; anything else → null. */
const parseDay = (value) => {
  if (typeof value !== 'string') return null;
  const m = DAY_RE.exec(value.trim());
  if (!m) return null;
  const dt = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] });
  return dt.isValid ? dt.toISODate() : null;
};

const isDay = (value) => parseDay(value) !== null;

const todayIn = (tz = DEFAULT_TZ, now = new Date()) => DateTime.fromJSDate(now).setZone(tz).toISODate();

const addDays = (day, n) => DateTime.fromISO(day).plus({ days: n }).toISODate();

/** Whole days from a to b (b - a). */
const diffDays = (a, b) => Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), 'days').days);

const eachDay = (from, to) => {
  const out = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
};

/** Week starts on SATURDAY (shift_models.dart). */
const weekStartOf = (day) => {
  const dt = DateTime.fromISO(day);
  const offset = (dt.weekday + 1) % 7; // luxon: Mon=1..Sun=7 → Sat=0
  return dt.minus({ days: offset }).toISODate();
};

/** Local day + minutes-after-midnight in `tz` → JS Date instant. */
const dayMinutesToInstant = (day, minutes, tz = DEFAULT_TZ) =>
  DateTime.fromISO(day, { zone: tz }).startOf('day').plus({ minutes }).toJSDate();

/** A shift's absolute window. `end <= start` means it crosses midnight. */
const shiftWindow = (day, startMinutes, endMinutes, tz = DEFAULT_TZ) => {
  const startsAt = dayMinutesToInstant(day, startMinutes, tz);
  const crossesMidnight = endMinutes <= startMinutes;
  const endsAt = dayMinutesToInstant(crossesMidnight ? addDays(day, 1) : day, endMinutes, tz);
  return { startsAt, endsAt, crossesMidnight };
};

/**
 * Parse an instant from the client. With an offset → absolute; without one →
 * wall-clock time in `tz`. Returns null for anything unparseable.
 */
const parseInstant = (value, tz = DEFAULT_TZ) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  const dt = OFFSET_RE.test(s) ? DateTime.fromISO(s, { setZone: true }) : DateTime.fromISO(s, { zone: tz });
  return dt.isValid ? dt.toJSDate() : null;
};

/** Calendar day (in tz) of an instant. */
const dayOf = (date, tz = DEFAULT_TZ) => DateTime.fromJSDate(date).setZone(tz).toISODate();

const iso = (date) => (date ? new Date(date).toISOString() : null);

const addMinutes = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60000);
const addHours = (date, hours) => addMinutes(date, hours * 60);
const addDaysInstant = (date, days) => new Date(new Date(date).getTime() + days * 86400000);

module.exports = {
  DEFAULT_TZ,
  parseDay,
  isDay,
  todayIn,
  addDays,
  diffDays,
  eachDay,
  weekStartOf,
  dayMinutesToInstant,
  shiftWindow,
  parseInstant,
  dayOf,
  iso,
  addMinutes,
  addHours,
  addDaysInstant,
};
