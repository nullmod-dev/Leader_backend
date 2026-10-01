/**
 * Tenant structure — /detachment-groups and /detachments. docs/api/detachments.md
 *
 * Reads the seeded saas_hilal structure (groups t_damascus / t_central /
 * t_coast; detachments d_dam_central, d_dam_rural, d_homs, d_coast and the
 * archived d_north_arch). Every write happens on a NEW group + detachment
 * created here and deleted at the end, so the seeded data is left untouched.
 */
module.exports = {
  name: 'Tenant · Detachment groups & detachments',
  order: 20,
  description:
    'Groups (list/get/create/update/cascade delete), detachments (list/filter/get/create/update/archive/restore/delete), ' +
    'daily stats and the detachment image. Writes only touch the group and detachment this folder creates.',
  items: [
    // ---- groups: reads --------------------------------------------------------------
    {
      name: 'Groups — list (Main Admin)',
      method: 'GET',
      path: '/detachment-groups',
      expect: 200,
      tests: [
        'pm.expect(json).to.be.an("array")',
        'pm.expect(json.map(g => g.id)).to.include.members(["t_damascus", "t_central", "t_coast"])',
        'const g = json.find(x => x.id === "t_damascus"); pm.expect(g.detachmentCount).to.be.a("number"); pm.expect(g.coveragePercent).to.be.within(0, 100);',
      ],
    },
    {
      name: 'Groups — list ?query=دمشق (Arabic folding)',
      method: 'GET',
      path: '/detachment-groups',
      query: { query: 'دمشق' },
      expect: 200,
      tests: ['pm.expect(json.map(g => g.id)).to.include("t_damascus")'],
    },
    {
      name: 'Groups — list (Simple Admin: groups holding d_dam_central / d_homs only)',
      method: 'GET',
      path: '/detachment-groups',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.map(g => g.id)).to.not.include("t_coast")'],
    },
    {
      name: 'Groups — get t_damascus',
      method: 'GET',
      path: '/detachment-groups/t_damascus',
      expect: 200,
      tests: ['pm.expect(json.id).to.eql("t_damascus")', 'pm.expect(json.version).to.be.a("number")'],
    },
    {
      name: 'Groups — get unknown → 404 not_found',
      method: 'GET',
      path: '/detachment-groups/g_does_not_exist',
      expect: 404,
      tests: ['pm.expect(json.error.code).to.eql("not_found")'],
    },

    // ---- groups: writes ----------------------------------------------------------------
    {
      name: 'Groups — create as Simple Admin → 403 not_permitted (no detachment.create)',
      method: 'POST',
      path: '/detachment-groups',
      auth: 'simple',
      body: { name: 'مجموعة غير مسموحة' },
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Groups — create with an empty name → 422 validation',
      method: 'POST',
      path: '/detachment-groups',
      body: { name: '   ' },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")', 'pm.expect(json.error.fields).to.have.property("name")'],
    },
    {
      name: 'Groups — create (new group)',
      method: 'POST',
      path: '/detachment-groups',
      idempotent: true,
      body: { name: 'مجموعة بوستمان {{$timestamp}}', notes: 'أنشئت من مجموعة Postman وتحذف في آخر المجلد.' },
      expect: 201,
      tests: [
        'pm.expect(json.id).to.match(/^g_/)',
        'pm.expect(json.status).to.eql("active")',
        'pm.expect([json.detachmentCount, json.memberCount, json.coveragePercent]).to.eql([0, 0, 0])',
      ],
      save: { newGroupId: 'json.id', newGroupName: 'json.name', newGroupVersion: 'json.version' },
    },
    {
      name: 'Groups — create a duplicate name → 409 conflict',
      method: 'POST',
      path: '/detachment-groups',
      body: { name: '{{newGroupName}}' },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("conflict")'],
    },
    {
      name: 'Groups — PUT (full JSON; roll-ups in the body are ignored)',
      method: 'PUT',
      path: '/detachment-groups/{{newGroupId}}',
      idempotent: true,
      // "version" arrives as the string "1" and is converted by validation.
      body: { id: '{{newGroupId}}', name: '{{newGroupName}} — معدلة', notes: 'ملاحظات محدثة', memberCount: 999, coveragePercent: 100, version: '{{newGroupVersion}}' },
      expect: 200,
      tests: ['pm.expect(json.memberCount).to.eql(0)', 'pm.expect(json.notes).to.eql("ملاحظات محدثة")', 'pm.expect(json.version).to.eql(2)'],
      save: { newGroupName: 'json.name' },
    },
    {
      name: 'Groups — PATCH with a stale version → 409 stale_write',
      method: 'PATCH',
      path: '/detachment-groups/{{newGroupId}}',
      body: { notes: 'لن تحفظ', version: 1 },
      expect: 409,
      tests: ['pm.expect(json.error.code).to.eql("stale_write")', 'pm.expect(json.error.currentVersion).to.eql(2)', 'pm.expect(json.error.currentRecord.id).to.eql(pm.collectionVariables.get("newGroupId"))'],
    },

    // ---- detachments: reads ------------------------------------------------------------
    {
      name: 'Detachments — list (Main Admin, every detachment)',
      method: 'GET',
      path: '/detachments',
      expect: 200,
      tests: [
        'pm.expect(json.map(d => d.id)).to.include.members(["d_dam_central", "d_dam_rural", "d_homs", "d_coast", "d_north_arch"])',
        'const d = json.find(x => x.id === "d_dam_central"); pm.expect(d.memberCount).to.be.above(0); pm.expect(d.weeklyShiftCount).to.be.a("number");',
      ],
    },
    {
      name: 'Detachments — list ?filter=archived',
      method: 'GET',
      path: '/detachments',
      query: { filter: 'archived' },
      expect: 200,
      tests: ['pm.expect(json.map(d => d.id)).to.include("d_north_arch")', 'pm.expect(json.every(d => d.status === "archived")).to.eql(true)'],
    },
    {
      name: 'Detachments — list ?detachmentGroupId=t_damascus',
      method: 'GET',
      path: '/detachments',
      query: { detachmentGroupId: 't_damascus' },
      expect: 200,
      tests: ['pm.expect(json.every(d => d.detachmentGroupId === "t_damascus")).to.eql(true)', 'pm.expect(json.map(d => d.id)).to.include("d_dam_central")'],
    },
    {
      name: 'Detachments — list (Simple Admin: d_dam_central + d_homs only)',
      method: 'GET',
      path: '/detachments',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.map(d => d.id).sort()).to.eql(["d_dam_central", "d_homs"])'],
    },
    {
      name: 'Detachments — get d_dam_central',
      method: 'GET',
      path: '/detachments/d_dam_central',
      expect: 200,
      tests: ['pm.expect(json.id).to.eql("d_dam_central")', 'pm.expect(json.detachmentGroupId).to.eql("t_damascus")'],
    },
    {
      name: 'Detachments — get d_coast as Simple Admin → 403 not_permitted',
      method: 'GET',
      path: '/detachments/d_coast',
      auth: 'simple',
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Detachments — stats d_dam_central (7 days)',
      method: 'GET',
      path: '/detachments/d_dam_central/stats',
      expect: 200,
      tests: [
        'pm.expect(json.attendanceSeries).to.have.lengthOf(7)',
        'pm.expect(json.coverageSeries).to.have.lengthOf(7)',
        'pm.expect(json.stockSeries).to.have.lengthOf(7)',
        'pm.expect(json.days[6]).to.eql(json.to)',
        'pm.expect(json.definitions).to.have.all.keys("attendanceSeries", "coverageSeries", "stockSeries")',
      ],
    },
    {
      name: 'Detachments — stats ?days=30',
      method: 'GET',
      path: '/detachments/d_dam_central/stats',
      query: { days: 30 },
      expect: 200,
      tests: ['pm.expect(json.days).to.have.lengthOf(30)'],
    },
    {
      name: 'Detachments — stats ?days=3 → 422 validation',
      method: 'GET',
      path: '/detachments/d_dam_central/stats',
      query: { days: 3 },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },

    // ---- detachments: writes on the new group ---------------------------------------------
    {
      name: 'Detachments — create in an unknown group → 422 validation',
      method: 'POST',
      path: '/detachments',
      body: { detachmentGroupId: 'g_does_not_exist', name: 'مفرزة يتيمة', region: 'دمشق', mainCenter: 'مركز' },
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("detachmentGroupId")'],
    },
    {
      name: 'Detachments — create in the new group',
      method: 'POST',
      path: '/detachments',
      idempotent: true,
      body: { detachmentGroupId: '{{newGroupId}}', name: 'مفرزة بوستمان', region: 'دمشق', mainCenter: 'مركز الاختبار', notes: 'تحذف في آخر المجلد' },
      expect: 201,
      tests: ['pm.expect(json.id).to.match(/^d_/)', 'pm.expect(json.detachmentGroupId).to.eql(pm.collectionVariables.get("newGroupId"))', 'pm.expect(json.memberCount).to.eql(0)'],
      save: { newDetachmentId: 'json.id' },
    },
    {
      name: 'Detachments — PUT (full JSON)',
      method: 'PUT',
      path: '/detachments/{{newDetachmentId}}',
      idempotent: true,
      body: { id: '{{newDetachmentId}}', detachmentGroupId: '{{newGroupId}}', name: 'مفرزة بوستمان المعدلة', region: 'ريف دمشق', mainCenter: 'مركز جديد', status: 'active' },
      expect: 200,
      tests: ['pm.expect(json.name).to.eql("مفرزة بوستمان المعدلة")', 'pm.expect(json.notes).to.eql(undefined)', 'pm.expect(json.version).to.eql(2)'],
    },
    {
      name: 'Detachments — PATCH region',
      method: 'PATCH',
      path: '/detachments/{{newDetachmentId}}',
      body: { region: 'دمشق', version: 2 },
      expect: 200,
      tests: ['pm.expect(json.region).to.eql("دمشق")', 'pm.expect(json.version).to.eql(3)'],
    },
    {
      name: 'Detachments — upload image (multipart "image")',
      method: 'POST',
      path: '/detachments/{{newDetachmentId}}/image',
      formData: [{ key: 'image', type: 'file', src: 'fixtures/sample.jpg' }],
      expect: 200,
      tests: ['pm.expect(json.imageUrl).to.match(/\\/images\\/detachments\\/.+\\.webp$/)'],
    },
    {
      name: 'Detachments — remove image',
      method: 'DELETE',
      path: '/detachments/{{newDetachmentId}}/image',
      expect: 200,
      tests: ['pm.expect(json.imageUrl).to.eql(undefined)'],
    },
    {
      name: 'Detachments — archive',
      method: 'POST',
      path: '/detachments/{{newDetachmentId}}/archive',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("archived")'],
    },
    {
      name: 'Detachments — restore',
      method: 'POST',
      path: '/detachments/{{newDetachmentId}}/restore',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("active")'],
    },
    {
      name: 'Groups — get the new group (roll-ups include the new detachment)',
      method: 'GET',
      path: '/detachment-groups/{{newGroupId}}',
      expect: 200,
      tests: ['pm.expect(json.detachmentCount).to.eql(1)'],
    },

    // ---- cascade delete ----------------------------------------------------------------------
    {
      name: 'Detachments — delete the new detachment (cascade)',
      method: 'DELETE',
      path: '/detachments/{{newDetachmentId}}',
      expect: 204,
    },
    {
      name: 'Detachments — get the deleted detachment → 404',
      method: 'GET',
      path: '/detachments/{{newDetachmentId}}',
      expect: 404,
      tests: ['pm.expect(json.error.code).to.eql("not_found")'],
    },
    {
      name: 'Groups — delete the new group (cascade)',
      method: 'DELETE',
      path: '/detachment-groups/{{newGroupId}}',
      expect: 204,
    },
    {
      name: 'Groups — get the deleted group → 404',
      method: 'GET',
      path: '/detachment-groups/{{newGroupId}}',
      expect: 404,
      tests: ['pm.expect(json.error.code).to.eql("not_found")'],
    },
  ],
};
