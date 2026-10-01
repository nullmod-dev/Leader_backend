/**
 * Authorization expiry (Main Admin seats, replacement designates and Simple
 * Admin invitations).
 *
 * Pending authorizations whose `expiresAt` has passed (server time) → status
 * `expired`. Every account still linked to one of them, that has not finished
 * setup, is withdrawn (linkStatus `withdrawn`, link cleared) — the same shape
 * `authorizationService.refreshLinkState` and invitation cancellation write.
 * Authorizations without an `expiresAt` never expire here.
 * Idempotent: a second run finds nothing to do. Returns the number expired.
 */
const { Authorization, Account } = require('../../models');

module.exports = {
  name: 'expire-invitations',
  description: 'Expire pending admin authorizations past their expiresAt and withdraw the accounts linked to them.',
  run: async (now = new Date()) => {
    const due = await Authorization.find({ status: 'pending', expiresAt: { $ne: null, $lte: now } })
      .select('_id')
      .lean();
    if (!due.length) return 0;
    const ids = due.map((d) => String(d._id));

    const result = await Authorization.updateMany(
      { _id: { $in: ids }, status: 'pending' },
      { $set: { status: 'expired' } },
    );
    await Account.updateMany(
      { linkedAuthorizationId: { $in: ids }, linkStatus: 'linked', setupCompleted: { $ne: true } },
      { $set: { linkStatus: 'withdrawn', linkedAuthorizationId: null } },
    );
    return result.modifiedCount || 0;
  },
};
