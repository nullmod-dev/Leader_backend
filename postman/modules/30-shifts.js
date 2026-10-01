/**
 * Folder 30 — shifts, templates, assignment and attendance (docs/api/shifts.md)
 * inside saas_hilal / d_dam_central.
 *
 * Seeded data is only READ. The folder creates its own records and removes
 * them at the end: a repeating shift for NEXT week (anchor + template) and a
 * whole-day shift for TODAY (for check-in/out). The copy-day / copy-week
 * requests write a few empty shifts 9–10 weeks ahead (harmless; a re-run
 * skips them as duplicates).
 *
 * Collection variables: shToday · shFrom · shTo · shNextSat · shNextMon ·
 * shNextWed · shFarDay · shFarWeek · shiftId · templateId · candidateId ·
 * todayShiftId · todayMemberId
 */
const DET = '/detachments/d_dam_central';
const SHIFT = '/shifts/{{shiftId}}';
const TODAY = '/shifts/{{todayShiftId}}';
const ATT = `${TODAY}/members/{{todayMemberId}}`;

const code = (c) => `pm.expect(json.error.code).to.eql("${c}")`;

// Dates in the tenant timezone (Asia/Damascus, UTC+3, no DST), weeks start on Saturday.
const computeDates = [
  'const DAY = 86400000;',
  'const local = new Date(Date.now() + 3 * 3600000);',
  'const iso = (d) => d.toISOString().slice(0, 10);',
  'const plus = (n) => new Date(local.getTime() + n * DAY);',
  'const toSat = (local.getUTCDay() + 1) % 7;',
  'const nextSat = 7 - toSat;',
  'pm.collectionVariables.set("shToday", iso(local));',
  'pm.collectionVariables.set("shFrom", iso(plus(-3)));',
  'pm.collectionVariables.set("shTo", iso(plus(3)));',
  'pm.collectionVariables.set("shNextSat", iso(plus(nextSat)));',
  'pm.collectionVariables.set("shNextMon", iso(plus(nextSat + 2)));',
  'pm.collectionVariables.set("shNextWed", iso(plus(nextSat + 4)));',
  'pm.collectionVariables.set("shFarDay", iso(plus(nextSat + 63)));',
  'pm.collectionVariables.set("shFarWeek", iso(plus(nextSat + 70)));',
];

module.exports = {
  name: 'Tenant · Shifts & attendance',
  order: 30,
  description:
    'Detachment schedule (today / week / range), create with repeat, the shift manage sheet (edit, repeat, candidates, ' +
    'assign, quick-fill), templates (list, dates reconciliation, stop), copy-day / copy-week, the attendance sheet ' +
    '(check-in / check-out / reset) and the correction form. Reference: backend/docs/api/shifts.md.',
  items: [
    // ---- reads ------------------------------------------------------------------------
    {
      name: 'Today — d_dam_central',
      method: 'GET',
      path: `${DET}/shifts/today`,
      prerequest: computeDates,
      expect: 200,
      tests: [
        'pm.expect(json).to.be.an("array")',
        'json.forEach((s) => pm.expect(s.date).to.eql(pm.collectionVariables.get("shToday")))',
        'if (json.length) pm.expect(json[0]).to.include.keys("id","attendees","startsAt","endsAt","attendanceClosesAt")',
      ],
    },
    {
      name: 'Week — d_dam_central (normalized to Saturday)',
      method: 'GET',
      path: `${DET}/shifts/week`,
      query: { weekStart: '{{shToday}}' },
      expect: 200,
      tests: [
        'pm.expect(json.days).to.have.length(7)',
        'pm.expect(new Date(json.weekStart + "T00:00:00Z").getUTCDay()).to.eql(6)',
        'pm.expect(json.summary).to.have.all.keys("shiftCount","needed","assigned","coveragePercent","gaps")',
      ],
    },
    {
      name: 'Range — d_dam_central (today ± 3 days)',
      method: 'GET',
      path: `${DET}/shifts`,
      query: { from: '{{shFrom}}', to: '{{shTo}}' },
      expect: 200,
      tests: ['pm.expect(json).to.be.an("array")'],
    },
    {
      name: 'Range without `to` → 422 validation',
      method: 'GET',
      path: `${DET}/shifts`,
      query: { from: '{{shFrom}}' },
      expect: 422,
      tests: [code('validation'), 'pm.expect(json.error.fields).to.have.property("to")'],
    },
    {
      name: 'Seeded live shift',
      method: 'GET',
      path: '/shifts/sh_live_today',
      expect: 200,
      tests: ['pm.expect(json.id).to.eql("sh_live_today")', 'pm.expect(json.attendees.length).to.be.at.least(1)'],
    },

    // ---- create with repeat (next week) -------------------------------------------------
    {
      name: 'Create repeating shift (next Sat + Mon + Wed)',
      method: 'POST',
      path: `${DET}/shifts`,
      idempotent: true,
      body: {
        date: '{{shNextSat}}',
        centerName: 'مركز الشعلان — تجربة Postman',
        startMinutes: 420,
        endMinutes: 900,
        needed: 4,
        repeatOn: ['{{shNextMon}}', '{{shNextWed}}'],
      },
      expect: 201,
      tests: [
        'pm.expect(json.date).to.eql(pm.collectionVariables.get("shNextSat"))',
        'pm.expect(json.templateId).to.be.a("string")',
        'pm.expect(json.attendees).to.eql([])',
      ],
      save: { shiftId: 'json.id', templateId: 'json.templateId' },
    },
    {
      name: 'Create with start == end → 422 validation',
      method: 'POST',
      path: `${DET}/shifts`,
      body: { date: '{{shNextSat}}', centerName: 'مركز', startMinutes: 480, endMinutes: 480, needed: 2 },
      expect: 422,
      tests: [code('validation'), 'pm.expect(json.error.fields).to.have.property("endMinutes")'],
    },
    { name: 'Get shift', method: 'GET', path: SHIFT, expect: 200, tests: ['pm.expect(json.id).to.eql(pm.collectionVariables.get("shiftId"))'] },
    {
      name: 'Update shift (PATCH)',
      method: 'PATCH',
      path: SHIFT,
      idempotent: true,
      body: { needed: 3, centerName: 'مركز الشعلان — القاعة ب' },
      expect: 200,
      tests: ['pm.expect(json.needed).to.eql(3)', 'pm.expect(json.version).to.be.at.least(2)'],
    },
    {
      name: 'Candidates',
      method: 'GET',
      path: `${SHIFT}/candidates`,
      expect: 200,
      tests: ['pm.expect(json).to.be.an("array")', 'if (json.length) pm.expect(json[0]).to.include.keys("member","busy")'],
      save: { candidateId: '(json.find((c) => !c.busy) || json[0] || { member: { id: "m1" } }).member.id' },
    },
    {
      name: 'Assign candidate',
      method: 'POST',
      path: `${SHIFT}/assignments`,
      idempotent: true,
      body: { memberId: '{{candidateId}}' },
      expect: 200,
      tests: ['pm.expect(json.attendees.map((a) => a.id)).to.include(pm.collectionVariables.get("candidateId"))'],
    },
    {
      name: 'Assign the same member again → 409 conflict',
      method: 'POST',
      path: `${SHIFT}/assignments`,
      body: { memberId: '{{candidateId}}' },
      expect: 409,
      tests: [code('conflict')],
    },
    {
      name: 'Quick-fill',
      method: 'POST',
      path: `${SHIFT}/quick-fill`,
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.added).to.be.a("number")', 'pm.expect(json.shift.assigned).to.be.at.most(json.shift.needed)'],
    },

    // ---- templates -------------------------------------------------------------------------
    {
      name: 'Repeat: keep Sat + Mon only',
      method: 'PUT',
      path: `${SHIFT}/repeat`,
      idempotent: true,
      body: { dates: ['{{shNextMon}}'] },
      expect: 200,
      tests: ['pm.expect(json.template.id).to.eql(pm.collectionVariables.get("templateId"))', 'pm.expect(json.shifts).to.be.an("array")'],
    },
    {
      name: 'Templates — d_dam_central (active)',
      method: 'GET',
      path: `${DET}/shift-templates`,
      query: { active: 'true' },
      expect: 200,
      tests: ['pm.expect(json.map((t) => t.id)).to.include(pm.collectionVariables.get("templateId"))'],
    },
    { name: 'Get template', method: 'GET', path: '/shift-templates/{{templateId}}', expect: 200, tests: ['pm.expect(json.active).to.eql(true)'] },
    {
      name: 'Template shifts',
      method: 'GET',
      path: '/shift-templates/{{templateId}}/shifts',
      expect: 200,
      tests: ['json.forEach((s) => pm.expect(s.templateId).to.eql(pm.collectionVariables.get("templateId")))'],
    },
    {
      name: 'Template dates: Sat + Mon + Wed (materializes Wed)',
      method: 'PUT',
      path: '/shift-templates/{{templateId}}/dates',
      idempotent: true,
      body: { dates: ['{{shNextSat}}', '{{shNextMon}}', '{{shNextWed}}'] },
      expect: 200,
      tests: ['pm.expect(json).to.have.all.keys("template","created","removed","kept")', 'pm.expect(json.template.dates).to.include(pm.collectionVariables.get("shNextWed"))'],
    },

    // ---- copy -------------------------------------------------------------------------------
    {
      name: 'Copy day (next Sat → +9 weeks)',
      method: 'POST',
      path: `${DET}/shifts/copy-day`,
      idempotent: true,
      body: { fromDay: '{{shNextSat}}', toDay: '{{shFarDay}}' },
      expect: 200,
      tests: ['pm.expect(json.created).to.be.a("number")'],
    },
    {
      name: 'Copy day onto itself → 422 validation',
      method: 'POST',
      path: `${DET}/shifts/copy-day`,
      body: { fromDay: '{{shNextSat}}', toDay: '{{shNextSat}}' },
      expect: 422,
      tests: [code('validation')],
    },
    {
      name: 'Copy week (next week → +10 weeks)',
      method: 'POST',
      path: `${DET}/shifts/copy-week`,
      idempotent: true,
      body: { fromWeekStart: '{{shNextSat}}', toWeekStart: '{{shFarWeek}}' },
      expect: 200,
      tests: ['pm.expect(json.created).to.be.a("number")'],
    },

    // ---- attendance on a shift covering now -------------------------------------------------
    {
      name: 'Create a whole-day shift for today',
      method: 'POST',
      path: `${DET}/shifts`,
      idempotent: true,
      body: { date: '{{shToday}}', centerName: 'مركز الشعلان — حضور Postman', startMinutes: 0, endMinutes: 1440, needed: 2 },
      expect: 201,
      save: { todayShiftId: 'json.id' },
    },
    {
      name: 'Candidates for today',
      method: 'GET',
      path: `${TODAY}/candidates`,
      expect: 200,
      save: { todayMemberId: '(json.find((c) => !c.busy) || json[0]).member.id' },
    },
    { name: 'Assign today member', method: 'POST', path: `${TODAY}/assignments`, idempotent: true, body: { memberId: '{{todayMemberId}}' }, expect: 200 },
    {
      name: 'Check-in (server now)',
      method: 'POST',
      path: `${ATT}/check-in`,
      idempotent: true,
      body: {},
      expect: 200,
      tests: ['const a = json.attendees.find((x) => x.id === pm.collectionVariables.get("todayMemberId")); pm.expect(a.attendance).to.eql("checkedIn"); pm.expect(a.checkInAt).to.be.a("string")'],
    },
    {
      name: 'Check-out',
      method: 'POST',
      path: `${ATT}/check-out`,
      idempotent: true,
      body: {},
      expect: 200,
      tests: ['const a = json.attendees.find((x) => x.id === pm.collectionVariables.get("todayMemberId")); pm.expect(a.attendance).to.eql("checkedOut")'],
    },
    {
      name: 'Correction (Main Admin, override)',
      method: 'POST',
      path: `${ATT}/attendance-corrections`,
      idempotent: true,
      body: { status: 'checkedIn', checkInAt: '{{shToday}}T08:05:00', checkOutAt: null, reason: 'نسي المشرف تسجيل الدخول وقت الشفت', correctedAt: '{{shToday}}T10:00:00' },
      expect: 200,
      tests: ['const c = json.corrections[json.corrections.length - 1]; pm.expect(c.reason).to.eql("نسي المشرف تسجيل الدخول وقت الشفت"); pm.expect(c.author.displayName).to.be.a("string")'],
    },
    {
      name: 'Correction — Simple Admin (no override) → 403',
      method: 'POST',
      path: `${ATT}/attendance-corrections`,
      auth: 'simple',
      body: { status: 'absent', reason: 'سبب' },
      expect: 403,
      tests: [code('not_permitted')],
    },
    {
      name: 'Corrections list',
      method: 'GET',
      path: `${TODAY}/attendance-corrections`,
      expect: 200,
      tests: ['pm.expect(json.length).to.be.at.least(1)'],
    },
    { name: 'Reset attendance', method: 'POST', path: `${ATT}/reset`, idempotent: true, expect: 200 },
    {
      name: 'Check-out without check-in → 422 check_in_required',
      method: 'POST',
      path: `${ATT}/check-out`,
      body: {},
      expect: 422,
      tests: [code('check_in_required')],
    },

    // ---- negatives ----------------------------------------------------------------------------
    {
      name: 'Simple Admin on d_dam_rural → 403 not_permitted',
      method: 'GET',
      path: '/detachments/d_dam_rural/shifts/today',
      auth: 'simple',
      expect: 403,
      tests: [code('not_permitted')],
    },
    { name: 'Unknown shift → 404', method: 'GET', path: '/shifts/sh_does_not_exist', expect: 404, tests: [code('not_found')] },

    // ---- cleanup ---------------------------------------------------------------------------
    { name: 'Unassign candidate', method: 'DELETE', path: `${SHIFT}/assignments/{{candidateId}}`, idempotent: true, expect: 200 },
    { name: 'Delete today shift', method: 'DELETE', path: TODAY, idempotent: true, expect: 204 },
    { name: 'Delete anchor shift', method: 'DELETE', path: SHIFT, idempotent: true, expect: 204 },
    {
      name: 'Template dates: none (removes the empty shifts)',
      method: 'PUT',
      path: '/shift-templates/{{templateId}}/dates',
      idempotent: true,
      body: { dates: [] },
      expect: 200,
      tests: ['pm.expect(json.template.active).to.eql(false)'],
    },
    { name: 'Stop template', method: 'POST', path: '/shift-templates/{{templateId}}/stop', idempotent: true, expect: 200, tests: ['pm.expect(json.active).to.eql(false)'] },
  ],
};
