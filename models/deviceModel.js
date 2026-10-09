/**
 * Device — one app installation as seen by one account.
 *
 * The app mints a random UUID v4 on first launch (secure storage, no hardware
 * id) and sends it as `X-Device-Id`. Only its hash is stored, scoped to the
 * account: the same installation is a separate record for every account it
 * signs into, and a reinstall is a new device.
 *
 * status
 *   trusted   — signs in without an email code. At most TRUSTED_DEVICES_MAX
 *               per account. A trusted device admitted by an email code on an
 *               account that already had a device starts RESTRICTED until
 *               `restrictedUntil`, unless a trusted device answered "Yes"
 *               (`approvedAt`).
 *   untrusted — proved the mailbox but found no free trusted slot. Every
 *               session on it is restricted, and every sign-in on it needs
 *               the code, until a trusted device approves it after a slot is
 *               freed.
 *   blocked   — a trusted device answered "No". It can never sign in to this
 *               account again (a reinstall mints a new id: the block is a
 *               speed bump; ending the sessions and the password reset are
 *               the protection).
 *
 * `noticePending` drives the "a new device signed in" notice on the account's
 * other trusted devices; answering Yes or No, or removing the device, clears it.
 */
const mongoose = require('mongoose');
const basePlugin = require('./plugins/base');

const deviceSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    idHash: { type: String, required: true },
    label: { type: String, default: 'Unknown device' },
    status: { type: String, enum: ['trusted', 'untrusted', 'blocked'], required: true },

    verifiedAt: Date,
    restrictedUntil: Date,
    approvedAt: Date,
    noticePending: { type: Boolean, default: false },
    // Bound from a session that existed before device trust shipped.
    legacy: { type: Boolean, default: false },

    lastSeenAt: { type: Date, default: Date.now },
    blockedAt: Date,
  },
  { timestamps: true, collection: 'devices' },
);

deviceSchema.plugin(basePlugin, { prefix: 'dv', hideTenantId: false });
deviceSchema.index({ accountId: 1, idHash: 1 }, { unique: true });

module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema);
