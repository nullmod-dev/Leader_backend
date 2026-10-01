/**
 * Break-glass settlement (API_CONTRACT.md → Point 12, "Terminates on").
 *
 *   active past expiresAt            → expired                    (break_glass_expired, system)
 *   bound Session revoked / missing  → ended session_ended        (break_glass_revoked, system)
 *   target tenant no longer active   → ended tenant_unavailable   (break_glass_revoked, system)
 *
 * Every transition is a conditional update + audit in one transaction, so a
 * concurrent read-settle never double-audits. Returns the number of grants moved.
 */
const breakGlassService = require('../../services/breakGlassService');

module.exports = {
  name: 'settle-break-glass',
  description: 'Expire or end break-glass grants whose window, bound session or target tenant is gone.',
  run: () => breakGlassService.settleAll(),
};
