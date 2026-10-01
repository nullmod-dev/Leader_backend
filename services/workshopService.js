/**
 * Workshop register rules (mock_workshop_repository.dart, server-side).
 *
 *  - Organisation-level: no detachment; all workshop.* capabilities global.
 *  - Seats: every register line (member or guest) takes one; organisers never do.
 *  - Duplicate names are checked WITHIN a kind (normalized nameKey).
 *  - Organisers and legacy roster lines are mutually exclusive per workshop.
 *  - An archived workshop is read-only: every mutation → 409 archived
 *    (restoring it through the archive endpoint is the one exception).
 *
 * Register writes run in a transaction that first TOUCHES the workshop
 * document; two concurrent register writes therefore conflict on that
 * document and the loser is retried by the driver, re-counting seats —
 * capacity and organiser exclusivity cannot be raced past.
 */
const { Workshop, WorkshopParticipant, TeamMember } = require('../models');
const serializers = require('./serializers');
const { withTransaction } = require('./txn');
const { staleWrite } = require('./versioning');
const { saveOrStale } = require('./shiftService');
const AppError = require('../utils/appError');
const { collapse, nameKey } = require('../utils/normalize');

const archivedError = () => new AppError('archived', 409, 'The workshop is archived. Restore it before changing it.');

const assertWritable = (w) => {
  if (!w) throw AppError.notFound('workshop');
  if (w.archived) throw archivedError();
};

const toJson = async (req, w) => (await serializers.workshops(req.tenantId, [w], { grant: req.grant }))[0];

async function registerCounts(tenantId, workshopId) {
  const [registered, guests] = await Promise.all([
    WorkshopParticipant.countDocuments({ tenantId, workshopId }),
    WorkshopParticipant.countDocuments({ tenantId, workshopId, kind: 'guest' }),
  ]);
  return { registered, guests };
}

/** Synchronous serializer for stale_write `currentRecord` (counts computed up front). */
const serializerFor = async (req, w) => {
  const counts = await registerCounts(req.tenantId, String(w._id));
  const members = await serializers.memberMap(req.tenantId, (w.organizingTeam || []).map((o) => o.memberId));
  return (doc) => serializers.workshop(doc, counts, members, { grant: req.grant });
};

const KIND_ORDER = { member: 0, guest: 1 };

/** The register: kind member first, then guest, then creation order. */
const registerOf = async (tenantId, workshopId) => {
  const list = await WorkshopParticipant.find({ tenantId, workshopId }).sort({ createdAt: 1, _id: 1 });
  return list.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
};

/**
 * Lock + re-read the workshop inside a transaction and run `fn(workshop, session)`.
 * The `updatedAt` touch is the write that makes concurrent register writes conflict.
 */
const withRegisterLock = (tenantId, workshopId, fn) =>
  withTransaction(async (session) => {
    const w = await Workshop.findOneAndUpdate(
      { _id: workshopId, tenantId },
      { $set: { updatedAt: new Date() } },
      { new: true, session, timestamps: false },
    );
    assertWritable(w);
    return fn(w, session);
  });

const normalizedNameOrThrow = (value, field = 'name') => {
  const n = collapse(value);
  if (!n) throw AppError.validation({ [field]: 'A name is required.' });
  return n;
};

const nameTaken = async (tenantId, workshopId, kind, name, { except, session } = {}) => {
  const filter = { tenantId, workshopId, kind, nameKey: nameKey(name) };
  if (except) filter._id = { $ne: String(except) };
  return !!(await WorkshopParticipant.exists(filter).session(session || null));
};

const duplicateError = () => new AppError('duplicate', 409, 'Someone with this name is already on the register.');

const assertSeat = async (tenantId, w, adding, session) => {
  const seated = await WorkshopParticipant.countDocuments({ tenantId, workshopId: String(w._id) }).session(session || null);
  if (seated + adding > w.capacity) {
    throw new AppError('workshop_full', 409, 'The workshop has no free seat for this.', {
      capacity: w.capacity,
      registered: seated,
      remaining: Math.max(0, w.capacity - seated),
    });
  }
};

/** POST /workshops/:id/team-members and /guests. */
const addLine = async ({ tenantId, workshopId, kind, name, role, paid }) =>
  withRegisterLock(tenantId, workshopId, async (w, session) => {
    if (await nameTaken(tenantId, workshopId, kind, name, { session })) throw duplicateError();
    await assertSeat(tenantId, w, 1, session);
    const p = new WorkshopParticipant({
      tenantId,
      workshopId,
      name,
      kind,
      role: kind === 'member' ? role : null,
      attendance: 'notCheckedIn',
      paymentStatus: paid ? 'paid' : 'unpaid',
    });
    await p.save({ session });
    return p;
  });

/** Resolve roster members, all or nothing (unknown id → 404). */
const resolveMembers = async (tenantId, ids, session) => {
  const docs = await TeamMember.find({ tenantId, _id: { $in: ids } }).session(session || null);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new AppError('not_found', 404, 'member not found', { memberIds: missing });
  return ids.map((id) => byId.get(id));
};

/** LEGACY POST /workshops/:id/participants {memberIds} — all or nothing. */
const addRosterLines = async ({ tenantId, workshopId, memberIds }) => {
  const ids = [...new Set(memberIds)];
  return withRegisterLock(tenantId, workshopId, async (w, session) => {
    const members = await resolveMembers(tenantId, ids, session);
    const onRegister = await WorkshopParticipant.find({ tenantId, workshopId, memberId: { $in: ids } }).session(session || null);
    if (onRegister.length) {
      throw new AppError('duplicate', 409, 'A member is already on the register.', { memberIds: onRegister.map((p) => p.memberId) });
    }
    const organisers = (w.organizingTeam || []).filter((o) => ids.includes(o.memberId)).map((o) => o.memberId);
    if (organisers.length) {
      throw new AppError('already_organizer', 409, 'A member is on this workshop’s organising team.', { memberIds: organisers });
    }
    await assertSeat(tenantId, w, ids.length, session);
    const out = [];
    for (const m of members) {
      const p = new WorkshopParticipant({
        tenantId,
        workshopId,
        name: m.name,
        kind: 'member',
        role: 'member',
        memberId: String(m._id),
        attendance: 'notCheckedIn',
        paymentStatus: 'unpaid',
      });
      // eslint-disable-next-line no-await-in-loop
      await p.save({ session });
      out.push(p);
    }
    return out;
  });
};

/** POST /workshops/:id/organizers {memberIds} — all or nothing, no seat limit. */
const addOrganizers = async ({ tenantId, workshopId, memberIds, version, serialize }) => {
  const ids = [...new Set(memberIds)];
  return withRegisterLock(tenantId, workshopId, async (w, session) => {
    if (version !== undefined && version !== null && w.version !== Number(version)) throw staleWrite(w, serialize);
    await resolveMembers(tenantId, ids, session);
    const already = (w.organizingTeam || []).filter((o) => ids.includes(o.memberId)).map((o) => o.memberId);
    if (already.length) {
      throw new AppError('duplicate', 409, 'A member is already on the organising team.', { memberIds: already });
    }
    const onRegister = await WorkshopParticipant.find({ tenantId, workshopId, memberId: { $in: ids } }).session(session || null);
    if (onRegister.length) {
      throw new AppError('already_participant', 409, 'A member is registered as a participant of this workshop.', {
        memberIds: onRegister.map((p) => p.memberId),
      });
    }
    ids.forEach((memberId) => w.organizingTeam.push({ memberId, attendance: 'notCheckedIn', checkInAt: null, checkOutAt: null }));
    await saveOrStale(w, serialize, { session });
    return w;
  });
};

module.exports = {
  archivedError,
  assertWritable,
  toJson,
  serializerFor,
  registerCounts,
  registerOf,
  withRegisterLock,
  normalizedNameOrThrow,
  nameTaken,
  duplicateError,
  addLine,
  addRosterLines,
  addOrganizers,
};
