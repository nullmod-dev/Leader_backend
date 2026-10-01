/**
 * Folder 32 — announcements (docs/api/announcements.md) in saas_hilal.
 * Publishes one announcement to d_dam_central and withdraws it (withdraw,
 * never delete — the record stays as notification history).
 *
 * Collection variables: annExpiresAt · announcementId
 */
const code = (c) => `pm.expect(json.error.code).to.eql("${c}")`;

module.exports = {
  name: 'Tenant · Announcements',
  order: 32,
  description:
    'Compose/publish (Idempotency-Key required), the visible list, one announcement, the all-detachments authority ' +
    'rule and withdraw. Reference: backend/docs/api/announcements.md.',
  items: [
    {
      name: 'Publish to d_dam_central',
      method: 'POST',
      path: '/announcements',
      idempotent: true,
      prerequest: ['pm.collectionVariables.set("annExpiresAt", new Date(Date.now() + 86400000).toISOString())'],
      body: {
        text: 'تنبيه: اجتماع مسؤولي المفرزة يوم الخميس الساعة ٧ مساءً في المركز الرئيسي.',
        detachmentIds: ['d_dam_central'],
        placements: ['home', 'detachment'],
        expiresAt: '{{annExpiresAt}}',
      },
      expect: 201,
      tests: ['pm.expect(json.placements).to.include("notifications")', 'pm.expect(json.status).to.eql("active")', 'pm.expect(json.authorName).to.be.a("string")'],
      save: { announcementId: 'json.id' },
    },
    {
      name: 'Publish without Idempotency-Key → 422',
      method: 'POST',
      path: '/announcements',
      body: { text: 'نص الإعلان للتجربة', detachmentIds: ['d_dam_central'], placements: [], expiresAt: '{{annExpiresAt}}' },
      expect: 422,
      tests: [code('validation'), 'pm.expect(json.error.fields).to.have.property("Idempotency-Key")'],
    },
    {
      name: 'Publish with a 3-letter text → 422',
      method: 'POST',
      path: '/announcements',
      idempotent: true,
      body: { text: 'قصر', detachmentIds: ['d_dam_central'], placements: [], expiresAt: '{{annExpiresAt}}' },
      expect: 422,
      tests: [code('validation'), 'pm.expect(json.error.fields).to.have.property("text")'],
    },
    {
      name: 'Simple Admin publishes to d_dam_rural → 403',
      method: 'POST',
      path: '/announcements',
      auth: 'simple',
      idempotent: true,
      body: { text: 'إعلان لمفرزة خارج الصلاحية', detachmentIds: ['d_dam_central', 'd_dam_rural'], placements: [], expiresAt: '{{annExpiresAt}}' },
      expect: 403,
      tests: [code('not_permitted')],
    },
    {
      name: 'List',
      method: 'GET',
      path: '/announcements',
      expect: 200,
      tests: ['pm.expect(json.announcements.map((a) => a.id)).to.include(pm.collectionVariables.get("announcementId"))'],
    },
    {
      name: 'List — Simple Admin (only its detachments)',
      method: 'GET',
      path: '/announcements',
      auth: 'simple',
      expect: 200,
      tests: ['json.announcements.forEach((a) => pm.expect(a.detachmentIds.some((d) => ["d_dam_central","d_homs"].includes(d))).to.eql(true))'],
    },
    { name: 'Get', method: 'GET', path: '/announcements/{{announcementId}}', expect: 200, tests: ['pm.expect(json.detachmentIds).to.eql(["d_dam_central"])'] },
    {
      name: 'Withdraw',
      method: 'POST',
      path: '/announcements/{{announcementId}}/withdraw',
      idempotent: true,
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("withdrawn")'],
    },
    {
      name: 'Withdraw again (idempotent 200)',
      method: 'POST',
      path: '/announcements/{{announcementId}}/withdraw',
      expect: 200,
      tests: ['pm.expect(json.status).to.eql("withdrawn")'],
    },
    { name: 'Unknown announcement → 404', method: 'GET', path: '/announcements/a_does_not_exist', expect: 404, tests: [code('not_found')] },
  ],
};
