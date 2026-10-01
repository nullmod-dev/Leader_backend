/**
 * Seed identities — shared by `npm run seed`, the Postman collection and the
 * docs. Ids and emails deliberately mirror the Flutter mocks
 * (demo_personas.dart, platform_tenant_fixtures.dart, mock_*_repository.dart)
 * so the app's developer sees familiar data once it talks to this backend.
 *
 * Every seeded account signs in with SEED_PASSWORD (default `Leader@12345`).
 */
module.exports = {
  accounts: {
    superAdmin: { id: 'u_demo_platform', email: 'nullmod.dev@gmail.com', name: 'مدير منصة ليدر' },
    mainAdmin: { id: 'u_demo_main', email: 'pbea4007@mtu.edu.iq', name: 'سلمى الحارثي' },
    simpleAdmin: { id: 'u_demo_simple', email: 'hamodekaherhm@gmail.com', name: 'حمود الإداري' },
    // Onboarding fixtures (Point 17)
    unlinked: { id: 'acc_unlinked', email: 'unlinked@mtm.test', name: 'مستخدم غير مرتبط' },
    unverified: { id: 'acc_unverified', email: 'unverified@mtm.test', name: 'مستخدم غير موثّق' },
    invitedSimpleAdmin: { email: 'noura@hilal-medical.org', name: 'نورة العتيبي' },
    nabdSeat: { id: 'ma_nabd', email: 'huda@nabd-team.org', name: 'هدى السالم' },
  },

  // The tenant the seeded Main/Simple Admin operate in.
  hilal: {
    id: 'saas_hilal',
    displayName: 'فرق الهلال الطبية',
    teamCode: 'MTM-4K7P-QX92',
    groups: { damascus: 't_damascus', central: 't_central', coast: 't_coast' },
    detachments: {
      damCentral: 'd_dam_central',
      damRural: 'd_dam_rural',
      homs: 'd_homs',
      coast: 'd_coast',
      northArchived: 'd_north_arch',
    },
    // The Simple Admin's scoped grant covers these two detachments.
    simpleAdminDetachments: ['d_dam_central', 'd_homs'],
    firstMemberId: 'm1',
    firstItemId: 'i1',
    firstWorkshopId: 'w1',
  },

  tenants: [
    { id: 'saas_hilal', teamCode: 'MTM-4K7P-QX92' },
    { id: 'saas_najd', teamCode: 'MTM-9WCT-3H5R' },
    { id: 'saas_sahel', teamCode: 'MTM-2FGD-8NVJ' },
    { id: 'saas_wadi', teamCode: 'MTM-7RMB-KZ64' },
    { id: 'saas_nabd', teamCode: 'MTM-5JQX-2TWD' },
    { id: 'saas_masar', teamCode: 'MTM-6PTH-9BSK' },
    { id: 'saas_afiah', teamCode: 'MTM-3XDN-7VGM' },
    { id: 'saas_rukn', teamCode: 'MTM-8SVZ-4CQR' },
  ],

  plans: ['mtm_core', 'mtm_standard', 'mtm_advanced'],
};
