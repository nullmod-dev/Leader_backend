/**
 * Customer Demo expiry (BACKEND-HANDOFF.md §12, item 3).
 *
 * Active demo sessions past `expiresAt` (server time) → status `expired`
 * + audit `customer_demo_session_expired` (actor system — time is not an
 * actor) + every session of the demo account revoked. Also revokes credentials
 * still live on demo accounts whose trial a read already marked closed.
 * Idempotent: a second run finds nothing to do.
 */
const demoService = require('../../services/demoService');

module.exports = {
  name: 'expire-demo-sessions',
  description: 'Expire Customer Demo sessions past their server-stamped expiresAt and revoke their credentials.',
  run: async () => {
    const expired = await demoService.expireDue({ revoke: true });
    const revoked = await demoService.revokeLeftovers();
    return expired + revoked;
  },
};
