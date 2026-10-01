/**
 * Wire JSON for tenant operational resources — the exact shapes the Flutter
 * `fromJson` methods read. Every module uses these (never raw `toJSON`) so a
 * TeamMember looks identical in a roster, a shift attendee list and a
 * workshop's organising team.
 */
const { canIn } = require('../config/capabilities');
const mask = require('../utils/mask');
const { fileUrl } = require('./sessionView');
const { iso } = require('../utils/time');

// ---- helpers ------------------------------------------------------------------

/** Load members by id into a Map (tenant-scoped). */
const memberMap = async (tenantId, ids) => {
  const { TeamMember } = require('../models');
  const unique = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const docs = await TeamMember.find({ tenantId, _id: { $in: unique } });
  return new Map(docs.map((d) => [String(d._id), d]));
};

/** Does this grant see phone numbers in `detachmentId`? */
const contactVisible = (grant, detachmentId) => canIn(grant, detachmentId, 'member.contact.view');

// ---- TeamMember -----------------------------------------------------------------

/**
 * @param member TeamMember doc
 * @param opts.grant  caller's capability grant (decides phoneMasked)
 */
const member = (m, { grant } = {}) => {
  const out = {
    id: String(m._id),
    name: m.name,
    initials: m.initials,
    department: m.department || '',
    personalNumber: m.personalNumber || '',
    role: m.role,
    detachmentId: m.detachmentId,
    attendance: m.attendance || 'notCheckedIn',
    active: m.active !== false,
    version: m.version,
  };
  if (m.phone && grant && contactVisible(grant, m.detachmentId)) out.phoneMasked = mask.phone(m.phone);
  const photoUrl = fileUrl(m.photoPath);
  if (photoUrl) out.photoUrl = photoUrl;
  return out;
};

/** A member line whose record was deleted since — still renders, never crashes. */
const missingMember = (memberId, detachmentId) => ({
  id: String(memberId),
  name: 'عضو محذوف',
  initials: '؟',
  department: '',
  personalNumber: '',
  role: 'member',
  detachmentId: detachmentId || '',
  attendance: 'notCheckedIn',
  active: false,
});

// ---- Shift ----------------------------------------------------------------------

const correction = (shiftId) => (c) => ({
  id: c._id,
  shiftId: String(shiftId),
  memberId: c.memberId,
  before: { status: c.before.status, ...(c.before.checkInAt ? { checkInAt: iso(c.before.checkInAt) } : {}), ...(c.before.checkOutAt ? { checkOutAt: iso(c.before.checkOutAt) } : {}) },
  after: { status: c.after.status, ...(c.after.checkInAt ? { checkInAt: iso(c.after.checkInAt) } : {}), ...(c.after.checkOutAt ? { checkOutAt: iso(c.after.checkOutAt) } : {}) },
  reason: c.reason,
  author: { id: c.author?.id, displayName: c.author?.displayName || '' },
  correctedAt: iso(c.correctedAt),
  ...(c.clientCorrectedAt ? { clientCorrectedAt: iso(c.clientCorrectedAt) } : {}),
});

/** Grace after the shift end during which ordinary attendance edits stay open. */
const attendanceGraceMinutes = () => {
  const cached = require('./settingsService').peek();
  return cached && Number.isFinite(cached.attendanceGraceMinutes) ? cached.attendanceGraceMinutes : 60;
};

/**
 * @param s        Shift doc
 * @param members  Map<memberId, TeamMember> (see memberMap)
 * @param opts.grant caller grant
 */
const shift = (s, members, { grant } = {}) => {
  const attendees = (s.attendees || []).map((a) => {
    const m = members && members.get(String(a.memberId));
    const base = m ? member(m, { grant }) : missingMember(a.memberId, s.detachmentId);
    base.attendance = a.attendance;
    if (a.checkInAt) base.checkInAt = iso(a.checkInAt);
    if (a.checkOutAt) base.checkOutAt = iso(a.checkOutAt);
    return base;
  });
  const out = {
    id: String(s._id),
    detachmentId: s.detachmentId,
    date: s.date,
    centerName: s.centerName,
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes,
    needed: s.needed,
    attendees,
    version: s.version,
    // Server-derived conveniences (the Flutter model derives these itself).
    startsAt: iso(s.startsAt),
    endsAt: iso(s.endsAt),
    crossesMidnight: s.endMinutes <= s.startMinutes,
    assigned: attendees.length,
    hasCoverageGap: attendees.length < s.needed,
    // When ordinary attendance edits close (server time). After this only an
    // appended correction (shift.attendance.override) can change attendance.
    attendanceClosesAt: s.endsAt ? iso(new Date(new Date(s.endsAt).getTime() + attendanceGraceMinutes() * 60000)) : null,
  };
  if (s.templateId) out.templateId = s.templateId;
  if (s.corrections && s.corrections.length) out.corrections = s.corrections.map(correction(s._id));
  return out;
};

/** Serialize many shifts with ONE member lookup. */
const shifts = async (tenantId, list, opts) => {
  const ids = list.flatMap((s) => (s.attendees || []).map((a) => a.memberId));
  const members = await memberMap(tenantId, ids);
  return list.map((s) => shift(s, members, opts));
};

const template = (t) => ({
  id: String(t._id),
  detachmentId: t.detachmentId,
  centerName: t.centerName,
  dates: [...(t.dates || [])].sort(),
  startMinutes: t.startMinutes,
  endMinutes: t.endMinutes,
  needed: t.needed,
  active: t.active !== false,
  version: t.version,
});

// ---- Inventory ------------------------------------------------------------------

const inventoryItem = (i) => {
  const out = {
    id: String(i._id),
    detachmentId: i.detachmentId,
    name: i.name,
    unit: i.unit,
    currentStock: i.currentStock,
    minimum: i.minimum,
    level: i.level,
    unitsPerStrip: i.unitsPerStrip || 1,
    stripsPerCarton: i.stripsPerCarton || 1,
    preferredUnit: i.preferredUnit || 'individual',
    version: i.version,
  };
  if (i.expiresOn) out.expiresOn = i.expiresOn;
  const imageUrl = fileUrl(i.imagePath);
  if (imageUrl) out.imageUrl = imageUrl;
  return out;
};

const movement = (mv) => {
  const out = {
    id: String(mv._id),
    itemId: mv.itemId,
    direction: mv.direction,
    quantity: mv.quantity,
    packagingUnit: mv.packagingUnit || 'individual',
    convertedBaseUnitQuantity: mv.convertedBaseUnitQuantity,
    reason: mv.reason || '',
    at: iso(mv.at),
  };
  ['itemName', 'source', 'performedBy', 'performedByName'].forEach((k) => {
    if (mv[k]) out[k] = mv[k];
  });
  if (mv.stockBefore !== undefined && mv.stockBefore !== null) out.stockBefore = mv.stockBefore;
  if (mv.stockAfter !== undefined && mv.stockAfter !== null) out.stockAfter = mv.stockAfter;
  return out;
};

// ---- Workshops ------------------------------------------------------------------

/**
 * @param w       Workshop doc
 * @param counts  { registered, guests } (server-derived from the register)
 * @param members Map for organisers
 */
const workshop = (w, counts, members, { grant } = {}) => {
  const organizingTeam = (w.organizingTeam || []).map((o) => {
    const m = members && members.get(String(o.memberId));
    const base = m ? member(m, { grant }) : missingMember(o.memberId, '');
    base.attendance = o.attendance;
    if (o.checkInAt) base.checkInAt = iso(o.checkInAt);
    if (o.checkOutAt) base.checkOutAt = iso(o.checkOutAt);
    return base;
  });
  const out = {
    id: String(w._id),
    name: w.name,
    at: iso(w.at),
    location: w.location,
    capacity: w.capacity,
    registered: counts ? counts.registered : 0,
    guests: counts ? counts.guests : 0,
    status: w.status,
    registrationFee: w.registrationFee || 0,
    archived: !!w.archived,
    organizingTeam,
    version: w.version,
  };
  const coverImageUrl = fileUrl(w.coverImagePath);
  if (coverImageUrl) out.coverImageUrl = coverImageUrl;
  return out;
};

/** Serialize many workshops with one count aggregation and one member lookup. */
const workshops = async (tenantId, list, opts) => {
  const { WorkshopParticipant } = require('../models');
  const ids = list.map((w) => String(w._id));
  const rows = await WorkshopParticipant.aggregate([
    { $match: { tenantId, workshopId: { $in: ids } } },
    { $group: { _id: '$workshopId', registered: { $sum: 1 }, guests: { $sum: { $cond: [{ $eq: ['$kind', 'guest'] }, 1, 0] } } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id, { registered: r.registered, guests: r.guests }]));
  const members = await memberMap(tenantId, list.flatMap((w) => (w.organizingTeam || []).map((o) => o.memberId)));
  return list.map((w) => workshop(w, counts.get(String(w._id)) || { registered: 0, guests: 0 }, members, opts));
};

const participant = (p) => {
  const out = {
    id: String(p._id),
    workshopId: p.workshopId,
    name: p.name,
    initials: p.initials,
    kind: p.kind,
    attendance: p.attendance || 'notCheckedIn',
    version: p.version,
  };
  if (p.kind === 'member') out.role = p.role || 'member';
  if (p.memberId) out.memberId = p.memberId;
  if (p.paymentStatus) out.paymentStatus = p.paymentStatus;
  return out;
};

// ---- Groups / detachments -------------------------------------------------------------

const detachmentGroup = (g, rollup = {}) => {
  const out = {
    id: String(g._id),
    name: g.name,
    createdAt: iso(g.createdAt),
    status: g.status,
    version: g.version,
    detachmentCount: rollup.detachmentCount || 0,
    memberCount: rollup.memberCount || 0,
    coveragePercent: rollup.coveragePercent || 0,
  };
  if (g.notes) out.notes = g.notes;
  return out;
};

const detachment = (d, rollup = {}) => {
  const out = {
    id: String(d._id),
    detachmentGroupId: d.detachmentGroupId,
    name: d.name,
    region: d.region || '',
    mainCenter: d.mainCenter || '',
    memberCount: rollup.memberCount || 0,
    weeklyShiftCount: rollup.weeklyShiftCount || 0,
    coveragePercent: rollup.coveragePercent || 0,
    status: d.status,
    version: d.version,
  };
  if (d.notes) out.notes = d.notes;
  const imageUrl = fileUrl(d.imagePath);
  if (imageUrl) out.imageUrl = imageUrl;
  return out;
};

module.exports = {
  memberMap,
  contactVisible,
  member,
  missingMember,
  shift,
  shifts,
  template,
  inventoryItem,
  movement,
  workshop,
  workshops,
  participant,
  detachmentGroup,
  detachment,
};
