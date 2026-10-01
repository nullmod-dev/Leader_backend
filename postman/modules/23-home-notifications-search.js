/**
 * Home, Notifications Center and Global Search.
 * docs/api/home-notifications-search.md
 *
 * Read-only against the seeded data, except the per-account notification
 * read/cleared sets (which never change any record).
 */
module.exports = {
  name: 'Tenant · Home, notifications & search',
  order: 23,
  description: 'HomeSummary for d_dam_central, the organisation overview, the derived notification feed with read/cleared state, and Global Search.',
  items: [
    // ---- home ----------------------------------------------------------------------------------
    {
      name: 'Home — summary d_dam_central',
      method: 'GET',
      path: '/home/summary',
      query: { detachmentId: 'd_dam_central' },
      expect: 200,
      tests: [
        'pm.expect(json.detachmentId).to.eql("d_dam_central")',
        'pm.expect(json.shifts).to.be.an("array")',
        'pm.expect(json.rosterCount).to.be.above(0)',
        'pm.expect(["empty","healthy","expiring","low","depleted"]).to.include(json.storageStatus)',
        'pm.expect(json.lowStockCount).to.be.a("number")',
        'pm.expect(json.expiringSoonCount).to.be.a("number")',
        'pm.expect(json.announcements).to.be.an("array")',
      ],
    },
    {
      name: 'Home — summary without detachmentId → 422 validation',
      method: 'GET',
      path: '/home/summary',
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("detachmentId")'],
    },
    {
      name: 'Home — summary d_coast as Simple Admin → 403 not_permitted',
      method: 'GET',
      path: '/home/summary',
      auth: 'simple',
      query: { detachmentId: 'd_coast' },
      expect: 403,
      tests: ['pm.expect(json.error.code).to.eql("not_permitted")'],
    },
    {
      name: 'Home — summary for an unknown detachment → 404 not_found',
      method: 'GET',
      path: '/home/summary',
      query: { detachmentId: 'd_does_not_exist' },
      expect: 404,
      tests: ['pm.expect(json.error.code).to.eql("not_found")'],
    },
    {
      name: 'Home — overview (Main Admin)',
      method: 'GET',
      path: '/home/overview',
      expect: 200,
      tests: [
        'pm.expect(json.totals).to.have.all.keys("detachments","members","todayShifts","understaffedShifts","lowStockItems","expiringItems")',
        'pm.expect(json.detachments.map(d => d.id)).to.not.include("d_north_arch")',
        'pm.expect(json.workshopsThisWeek).to.be.a("number")',
      ],
    },
    {
      name: 'Home — overview (Simple Admin: two detachments)',
      method: 'GET',
      path: '/home/overview',
      auth: 'simple',
      expect: 200,
      tests: ['pm.expect(json.detachments.map(d => d.id).sort()).to.eql(["d_dam_central","d_homs"])'],
    },

    // ---- notifications ---------------------------------------------------------------------------
    {
      name: 'Notifications — feed d_dam_central',
      method: 'GET',
      path: '/notifications',
      query: { detachmentId: 'd_dam_central' },
      expect: 200,
      tests: [
        'pm.expect(json.notifications).to.be.an("array")',
        'json.notifications.forEach(n => { pm.expect(n.id).to.eql(n.kind + ":" + n.id.split(":").slice(1).join(":")); pm.expect(n.isRead).to.be.a("boolean"); })',
      ],
      save: {
        firstNotificationId: '(json.notifications.find(n => n.kind !== "announcement") || { id: "syncConflict:postman-op" }).id',
        firstAnnouncementRowId: '(json.notifications.find(n => n.kind === "announcement") || { id: "announcement:postman-none" }).id',
      },
    },
    {
      name: 'Notifications — unread count',
      method: 'GET',
      path: '/notifications/unread-count',
      query: { detachmentId: 'd_dam_central' },
      expect: 200,
      tests: ['pm.expect(json.count).to.be.a("number")'],
    },
    {
      name: 'Notifications — mark read (unknown ids are stored too)',
      method: 'PUT',
      path: '/notifications/read',
      idempotent: true,
      body: { ids: ['{{firstNotificationId}}', 'syncFailed:postman-op'] },
      expect: 200,
      tests: ['pm.expect(json.readIds).to.include.members([pm.collectionVariables.get("firstNotificationId"), "syncFailed:postman-op"])'],
    },
    {
      name: 'Notifications — clear announcement history',
      method: 'PUT',
      path: '/notifications/cleared',
      idempotent: true,
      body: { ids: ['{{firstAnnouncementRowId}}'] },
      expect: 200,
      tests: ['pm.expect(json.clearedIds).to.include(pm.collectionVariables.get("firstAnnouncementRowId"))'],
    },
    {
      name: 'Notifications — state',
      method: 'GET',
      path: '/notifications/state',
      expect: 200,
      tests: ['pm.expect(json.readIds).to.include("syncFailed:postman-op")', 'pm.expect(json.clearedIds).to.be.an("array")'],
    },
    {
      name: 'Notifications — mark read with an empty list → 422 validation',
      method: 'PUT',
      path: '/notifications/read',
      body: { ids: [] },
      expect: 422,
      tests: ['pm.expect(json.error.code).to.eql("validation")'],
    },

    // ---- search ----------------------------------------------------------------------------------------
    {
      name: 'Search — "شاش" (items, Arabic folding)',
      method: 'GET',
      path: '/search',
      query: { q: 'شاش' },
      expect: 200,
      tests: [
        'pm.expect(json.query).to.eql("شاش")',
        'pm.expect(json.results.some(r => r.type === "item" && r.target.type === "storage")).to.eql(true)',
        'pm.expect(json.results.every(r => r.detachmentId !== "d_north_arch")).to.eql(true)',
      ],
    },
    {
      name: 'Search — read m1 to get a member name',
      method: 'GET',
      path: '/members/m1',
      expect: 200,
      save: { m1Name: 'json.name' },
    },
    {
      name: 'Search — a member name',
      method: 'GET',
      path: '/search',
      query: { q: '{{m1Name}}', types: 'member' },
      expect: 200,
      tests: ['pm.expect(json.results[0].id).to.eql("m1")', 'pm.expect(json.results[0].target).to.eql({ type: "member", detachmentId: "d_dam_central", memberId: "m1" })'],
    },
    {
      name: 'Search — without q → 422 validation',
      method: 'GET',
      path: '/search',
      expect: 422,
      tests: ['pm.expect(json.error.fields).to.have.property("q")'],
    },
  ],
};
