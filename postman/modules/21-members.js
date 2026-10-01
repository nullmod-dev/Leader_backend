/**
 * Team members — /detachments/:id/members and /members. docs/api/members.md
 *
 * Reads the seeded d_dam_central roster (m1 … m10, personal numbers 101 …
 * 110). Every write happens on members created here (names carry a
 * timestamp) and deleted at the end, so the seeded roster is left untouched.
 */
module.exports = {
  name: 'Tenant · Team members',
  order: 21,
  description:
    'Roster reads (phoneMasked only with member.contact.view), create / quick-create / match / edit / role / roster attendance / ' +
    'deactivate / reactivate / photo / delete, and the business codes name_taken and number_taken.',
  items: [
    // ---- roster --------------------------------------------------------------------------
    {
      name: 'Roster — d_dam_central (Main Admin)',
      method: 'GET',
      path: '/detachments/d_dam_central/members',
      expect: 200,
      tests: [
        'pm.expect(json).to.be.an("array").that.is.not.empty',
        'pm.expect(json[0].role).to.eql("shiftSupervisor")',
        'pm.expect(json.some(m => typeof m.phoneMasked === "string")).to.eql(true)',
        'pm.expect(json.every(m => m.phone === undefined)).to.eql(true)',
      ],
    },
    {
      name: 'Roster — d_dam_central (Simple Admin holds member.contact.view there)',
      method: 'GET',
      path: '/detachments/d_dam_central/members',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.some(m => typeof m.phoneMasked === "string")).to.eql(true)'],
    },
    {
      name: 'Roster — d_coast as Simple Admin → 403 not_permitted',
      method: 'GET',
      path: '/detachments/d_coast/members',
      auth: 'simple',
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Roster — ?includeInactive=true',
      method: 'GET',
      path: '/detachments/d_dam_central/members',
      query: { includeInactive: true },
      expect: 200,
      tests: ['pm.expect(json).to.be.an("array")'],
    },

    // ---- create ------------------------------------------------------------------------------
    {
      name: 'Members — create (legacy role "medic" is stored as administrator)',
      method: 'POST',
      path: '/members',
      idempotent: true,
      body: {
        detachmentId: 'd_dam_central',
        name: 'متطوع بوستمان {{$timestamp}}',
        department: 'الإسعاف',
        personalNumber: 'PM-{{$timestamp}}',
        role: 'medic',
        phone: '+963 944 123 456',
      },
      expect: 201,
      tests: [
        'pm.expect(json.id).to.match(/^m_/)',
        'pm.expect(json.role).to.eql("administrator")',
        'pm.expect(json.phoneMasked).to.eql("+963 9xx xxx 456")',
        'pm.expect(json.active).to.eql(true)',
      ],
      save: { newMemberId: 'json.id', newMemberName: 'json.name', newMemberNumber: 'json.personalNumber' },
    },
    {
      name: 'Members — create the same name again → 409 name_taken',
      method: 'POST',
      path: '/members',
      body: { detachmentId: 'd_dam_central', name: '{{newMemberName}}' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("name_taken")'],
    },
    {
      name: 'Members — create with a used personal number (101) → 409 number_taken',
      method: 'POST',
      path: '/members',
      body: { detachmentId: 'd_dam_central', name: 'اسم فريد {{$timestamp}}', personalNumber: '101' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("number_taken")'],
    },
    {
      name: 'Members — create with an empty name → 422 validation',
      method: 'POST',
      path: '/members',
      body: { detachmentId: 'd_dam_central', name: '' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("name")'],
    },
    {
      name: 'Members — create in d_coast as Simple Admin → 403 not_permitted',
      method: 'POST',
      path: '/members',
      auth: 'simple',
      body: { detachmentId: 'd_coast', name: 'غير مسموح {{$timestamp}}' },
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Members — quick member from a shift (personalNumber shift-<n>)',
      method: 'POST',
      path: '/members/from-shift',
      idempotent: true,
      body: { detachmentId: 'd_dam_central', name: 'متطوع مناوبة {{$timestamp}}' },
      expect: 201,
      tests: ['pm.expect(json.personalNumber).to.match(/^shift-\\d+$/)', 'pm.expect(json.role).to.eql("member")'],
      save: { quickMemberId: 'json.id' },
    },

    // ---- read / match -------------------------------------------------------------------------
    {
      name: 'Members — match by normalized name',
      method: 'GET',
      path: '/members/match',
      query: { detachmentId: 'd_dam_central', name: '{{newMemberName}}' },
      expect: 200,
      tests: ['pm.expect(json.match.id).to.eql(pm.collectionVariables.get("newMemberId"))'],
    },
    {
      name: 'Members — match with no hit → { match: null }',
      method: 'GET',
      path: '/members/match',
      query: { detachmentId: 'd_dam_central', name: 'لا أحد بهذا الاسم' },
      expect: 200,
      tests: ['pm.expect(json.match).to.eql(null)'],
    },
    {
      name: 'Members — get the new member',
      method: 'GET',
      path: '/members/{{newMemberId}}',
      expect: 200,
      tests: ['pm.expect(json.detachmentId).to.eql("d_dam_central")'],
    },

    // ---- edit ------------------------------------------------------------------------------------
    {
      name: 'Members — PUT (form fields; the stored phone is kept)',
      method: 'PUT',
      path: '/members/{{newMemberId}}',
      idempotent: true,
      body: { id: '{{newMemberId}}', name: '{{newMemberName}}', department: 'الإسناد اللوجستي', personalNumber: '{{newMemberNumber}}' },
      expect: 200,
      tests: ['pm.expect(json.department).to.eql("الإسناد اللوجستي")', 'pm.expect(json.phoneMasked).to.be.a("string")', 'pm.expect(json.version).to.eql(2)'],
    },
    {
      name: 'Members — PATCH onto a used personal number (101) → 409 number_taken',
      method: 'PATCH',
      path: '/members/{{newMemberId}}',
      body: { personalNumber: '101' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("number_taken")'],
    },
    {
      name: 'Members — PATCH /role (legacy "lead" → shiftSupervisor)',
      method: 'PATCH',
      path: '/members/{{newMemberId}}/role',
      idempotent: true,
      body: { role: 'lead' },
      expect: 200,
      tests: ['pm.expect(json.role).to.eql("shiftSupervisor")'],
    },
    {
      name: 'Members — PATCH /attendance (legacy "present" → checkedIn)',
      method: 'PATCH',
      path: '/members/{{newMemberId}}/attendance',
      body: { attendance: 'present' },
      expect: 200,
      tests: ['pm.expect(json.attendance).to.eql("checkedIn")'],
    },
    {
      name: 'Members — PATCH with a stale version → 409 stale_write',
      method: 'PATCH',
      path: '/members/{{newMemberId}}',
      body: { department: 'لن تحفظ', version: 1 },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("stale_write")', 'pm.expect(json.error.currentRecord.id).to.eql(pm.collectionVariables.get("newMemberId"))'],
    },
    {
      name: 'Members — upload photo (multipart "image")',
      method: 'POST',
      path: '/members/{{newMemberId}}/photo',
      formData: [{ key: 'image', type: 'file', src: 'fixtures/sample.jpg' }],
      expect: 200,
      tests: ['pm.expect(json.photoUrl).to.match(/\\/images\\/members\\/.+\\.webp$/)'],
    },
    {
      name: 'Members — remove photo',
      method: 'DELETE',
      path: '/members/{{newMemberId}}/photo',
      expect: 200,
      tests: ['pm.expect(json.photoUrl).to.eql(undefined)'],
    },
    {
      name: 'Members — deactivate',
      method: 'POST',
      path: '/members/{{newMemberId}}/deactivate',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.active).to.eql(false)'],
    },
    {
      name: 'Members — reactivate',
      method: 'POST',
      path: '/members/{{newMemberId}}/reactivate',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.active).to.eql(true)'],
    },

    // ---- delete ------------------------------------------------------------------------------------
    {
      name: 'Members — delete the quick member',
      method: 'DELETE',
      path: '/members/{{quickMemberId}}',
      expect: 204,
    },
    {
      name: 'Members — delete the new member',
      method: 'DELETE',
      path: '/members/{{newMemberId}}',
      expect: 204,
    },
    {
      name: 'Members — get the deleted member → 404',
      method: 'GET',
      path: '/members/{{newMemberId}}',
      expect: 404,
      tests: ['pm.expect(json.error.code).to.eql("not_found")'],
    },
  ],
};
