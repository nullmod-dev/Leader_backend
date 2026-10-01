/**
 * Folder 31 — workshops, the register, organisers, stats and export
 * (docs/api/workshops.md) in saas_hilal.
 *
 * Seeded workshops (w1…) are only READ. Mutations run on a workshop this
 * folder creates (`newWorkshopId`); it is archived at the end so it no longer
 * counts against the plan's `workshops` limit.
 *
 * Collection variables: wsAt · newWorkshopId · wsParticipantId · wsGuestId
 */
const NEW = '/workshops/{{newWorkshopId}}';
const code = (c) => `pm.expect(json.error.code).to.eql("${c}")`;

module.exports = {
  name: 'Tenant · Workshops',
  order: 31,
  description:
    'The /workshop list and detail, create/update, the register (team members typed by name, guests, legacy roster ' +
    'lines), attendance and payment, organisers, statistics, CSV export and archive/restore. ' +
    'Reference: backend/docs/api/workshops.md.',
  items: [
    {
      name: 'List workshops',
      method: 'GET',
      path: '/workshops',
      expect: 200,
      tests: ['pm.expect(json).to.be.an("array")', 'pm.expect(json.map((w) => w.id)).to.include("w1")'],
    },
    { name: 'List — upcoming', method: 'GET', path: '/workshops', query: { bucket: 'upcoming' }, expect: 200, tests: ['json.forEach((w) => pm.expect(w.archived).to.eql(false))'] },
    { name: 'Get w1', method: 'GET', path: '/workshops/w1', expect: 200, tests: ['pm.expect(json.registered).to.be.a("number")', 'pm.expect(json.organizingTeam).to.be.an("array")'] },
    { name: 'w1 participants', method: 'GET', path: '/workshops/w1/participants', expect: 200, tests: ['pm.expect(json).to.be.an("array")'] },

    {
      name: 'Create workshop',
      method: 'POST',
      path: '/workshops',
      idempotent: true,
      prerequest: ['pm.collectionVariables.set("wsAt", new Date(Date.now() + 14 * 86400000).toISOString())'],
      body: { name: 'ورشة Postman — الإنعاش القلبي', at: '{{wsAt}}', location: 'قاعة التدريب — دمشق', capacity: 10, registrationFee: 15000 },
      expect: 201,
      tests: ['pm.expect(json.status).to.eql("scheduled")', 'pm.expect(json.registered).to.eql(0)', 'pm.expect(json.organizingTeam).to.eql([])'],
      save: { newWorkshopId: 'json.id' },
    },
    {
      name: 'Create with blank name → 422 validation',
      method: 'POST',
      path: '/workshops',
      body: { name: '   ', at: '{{wsAt}}', location: 'قاعة', capacity: 10 },
      expect: 422,
      tests: [code('validation')],
    },
    {
      name: 'Update workshop',
      method: 'PATCH',
      path: NEW,
      idempotent: true,
      body: { name: 'ورشة Postman — الإنعاش القلبي الرئوي', capacity: 12, status: 'scheduled', registered: 99 },
      expect: 200,
      tests: ['pm.expect(json.capacity).to.eql(12)', 'pm.expect(json.registered).to.eql(0)'],
    },
    {
      name: 'Add team member',
      method: 'POST',
      path: `${NEW}/team-members`,
      idempotent: true,
      body: { name: 'سارة المصري', role: 'trainer', paid: true },
      expect: 201,
      tests: ['pm.expect(json.kind).to.eql("member")', 'pm.expect(json.paymentStatus).to.eql("paid")'],
      save: { wsParticipantId: 'json.id' },
    },
    {
      name: 'Add the same team member → 409 duplicate',
      method: 'POST',
      path: `${NEW}/team-members`,
      body: { name: '  سارة   المصري ', role: 'member', paid: false },
      expect: 409,
      tests: [code('duplicate')],
    },
    {
      name: 'Add guest',
      method: 'POST',
      path: `${NEW}/guests`,
      idempotent: true,
      body: { name: 'عمر الشامي' },
      expect: 201,
      tests: ['pm.expect(json.kind).to.eql("guest")', 'pm.expect(json).to.not.have.property("role")'],
      save: { wsGuestId: 'json.id' },
    },
    {
      name: 'Participant attendance',
      method: 'PATCH',
      path: '/workshop-participants/{{wsParticipantId}}/attendance',
      idempotent: true,
      body: { attendance: 'checkedIn' },
      expect: 200,
      tests: ['pm.expect(json.attendance).to.eql("checkedIn")'],
    },
    {
      name: 'Guest payment',
      method: 'PATCH',
      path: '/workshop-participants/{{wsGuestId}}/payment',
      idempotent: true,
      body: { paymentStatus: 'paid' },
      expect: 200,
      tests: ['pm.expect(json.paymentStatus).to.eql("paid")'],
    },
    {
      name: 'Update team member line',
      method: 'PUT',
      path: '/workshop-participants/{{wsParticipantId}}',
      idempotent: true,
      body: { name: 'سارة المصري', role: 'leader', paid: true },
      expect: 200,
      tests: ['pm.expect(json.role).to.eql("leader")', 'pm.expect(json.attendance).to.eql("checkedIn")'],
    },
    { name: 'Participants', method: 'GET', path: `${NEW}/participants`, expect: 200, tests: ['pm.expect(json.map((p) => p.kind)).to.eql(["member","guest"])'] },
    {
      name: 'Add organiser m3',
      method: 'POST',
      path: `${NEW}/organizers`,
      idempotent: true,
      body: { memberIds: ['m3'] },
      expect: 200,
      tests: ['pm.expect(json.organizingTeam.map((o) => o.id)).to.include("m3")'],
    },
    {
      name: 'Organiser attendance',
      method: 'PATCH',
      path: `${NEW}/organizers/m3/attendance`,
      idempotent: true,
      body: { attendance: 'checkedIn' },
      expect: 200,
    },
    {
      name: 'Register an organiser (legacy) → 409 already_organizer',
      method: 'POST',
      path: `${NEW}/participants`,
      body: { memberIds: ['m3'] },
      expect: 409,
      tests: [code('already_organizer')],
    },
    {
      name: 'Stats',
      method: 'GET',
      path: `${NEW}/stats`,
      expect: 200,
      tests: [
        'pm.expect(json.registeredCount).to.eql(2)',
        'pm.expect(json.participants.present).to.eql(1)',
        'pm.expect(json.team.total).to.eql(1)',
        'pm.expect(json.totalPaidAmount).to.eql(30000)',
      ],
    },
    {
      name: 'Export CSV',
      method: 'GET',
      path: `${NEW}/export.csv`,
      expect: 200,
      tests: ['pm.expect(pm.response.headers.get("Content-Type")).to.include("text/csv")', 'pm.expect(pm.response.text()).to.include("name,kind,role,attendance,payment")'],
    },
    { name: 'Remove organiser m3', method: 'DELETE', path: `${NEW}/organizers/m3`, idempotent: true, expect: 200 },
    {
      name: 'Register m4 (legacy roster line)',
      method: 'POST',
      path: `${NEW}/participants`,
      idempotent: true,
      body: { memberIds: ['m4'] },
      expect: 201,
      tests: ['pm.expect(json[0].memberId).to.eql("m4")'],
    },
    {
      name: 'Archive — Simple Admin (no workshop.archive) → 403',
      method: 'PATCH',
      path: `${NEW}/archive`,
      auth: 'simple',
      body: { archived: true },
      expect: 403,
      tests: [code('not_permitted')],
    },
    { name: 'Archive', method: 'PATCH', path: `${NEW}/archive`, idempotent: true, body: { archived: true }, expect: 200, tests: ['pm.expect(json.archived).to.eql(true)'] },
    {
      name: 'Add guest to archived → 409 archived',
      method: 'POST',
      path: `${NEW}/guests`,
      body: { name: 'متأخر' },
      expect: 409,
      tests: [code('archived')],
    },
    { name: 'Restore', method: 'PATCH', path: `${NEW}/archive`, idempotent: true, body: { archived: false }, expect: 200, tests: ['pm.expect(json.archived).to.eql(false)'] },
    { name: 'Remove guest line', method: 'DELETE', path: '/workshop-participants/{{wsGuestId}}', idempotent: true, expect: 204 },
    { name: 'Archive (cleanup)', method: 'PATCH', path: `${NEW}/archive`, idempotent: true, body: { archived: true }, expect: 200 },
    { name: 'Unknown workshop → 404', method: 'GET', path: '/workshops/w_does_not_exist', expect: 404, tests: [code('not_found')] },
  ],
};
