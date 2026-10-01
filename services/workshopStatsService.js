/**
 * Server-side WorkshopStats (lib/features/workshop/domain/workshop_stats.dart).
 *
 * Two groups, never averaged together:
 *   participants — the whole register (member AND guest lines)
 *   team         — the organising team only; carries no payment at all
 *
 *   present          = attendance checkedIn OR checkedOut
 *   absent           = total − present
 *   percent          = total == 0 ? 0 : clamp(round(present / total × 100), 0, 100)
 *   paid             = participants with paymentStatus 'paid'
 *   unpaid           = total − paid          (null counts as unpaid)
 *   capacityPercent  = capacity == 0 ? 0 : clamp(round(registered / capacity × 100), 0, 100)
 *   totalPaidAmount  = registrationFee × paid participants
 *   isFree           = registrationFee == 0
 */
const { iso } = require('../utils/time');

const wasPresent = (attendance) => attendance === 'checkedIn' || attendance === 'checkedOut';

const clampPercent = (n) => Math.min(100, Math.max(0, Math.round(n)));
const percentOf = (part, total) => (total === 0 ? 0 : clampPercent((part / total) * 100));

const groupStats = (people) => {
  const total = people.length;
  const present = people.filter((p) => wasPresent(p.attendance)).length;
  return { total, present, absent: total - present, percent: percentOf(present, total) };
};

/**
 * @param w         Workshop doc
 * @param register  WorkshopParticipant docs (register order)
 * @param members   Map<memberId, TeamMember> for the organising team
 */
const compute = (w, register, members) => {
  const fee = Number(w.registrationFee || 0);
  const capacity = Number(w.capacity || 0);

  const participantPeople = register.map((p) => ({
    id: String(p._id),
    name: p.name,
    group: 'participant',
    kind: p.kind,
    role: p.kind === 'guest' ? 'guest' : p.role || 'member',
    attendance: p.attendance || 'notCheckedIn',
    paymentStatus: p.paymentStatus || null,
  }));
  const teamPeople = (w.organizingTeam || []).map((o) => {
    const m = members && members.get(String(o.memberId));
    return {
      id: String(o.memberId),
      name: m ? m.name : 'عضو محذوف',
      group: 'team',
      role: m ? m.role : 'member',
      attendance: o.attendance || 'notCheckedIn',
      paymentStatus: null,
    };
  });

  const paid = participantPeople.filter((p) => p.paymentStatus === 'paid').length;
  const participants = { ...groupStats(participantPeople), paid, unpaid: participantPeople.length - paid };
  const team = groupStats(teamPeople);

  return {
    workshopId: String(w._id),
    name: w.name,
    at: iso(w.at),
    location: w.location,
    registrationFee: fee,
    isFree: fee === 0,
    capacity,
    registeredCount: participants.total,
    guests: participantPeople.filter((p) => p.kind === 'guest').length,
    capacityPercent: percentOf(participants.total, capacity),
    participants,
    team,
    totalPaidAmount: fee * paid,
    people: [...participantPeople, ...teamPeople],
  };
};

// ---- CSV export ----------------------------------------------------------------------

/** Quote a CSV cell; neutralize spreadsheet formulas (=, +, -, @ leading). */
const cell = (value) => {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** UTF-8 with BOM (Excel reads Arabic correctly), CRLF line ends. */
const registerCsv = (register) => {
  const rows = [['name', 'kind', 'role', 'attendance', 'payment']];
  register.forEach((p) => {
    rows.push([p.name, p.kind, p.kind === 'member' ? p.role || 'member' : '', p.attendance || 'notCheckedIn', p.paymentStatus || 'unpaid']);
  });
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
};

module.exports = { compute, registerCsv, wasPresent, percentOf };
