/**
 * Forced-upgrade gate (FRONTEND-BACKEND-INTEGRATION.md §1).
 *
 * The client sends `X-Client-Version: <semver>`. If it is below the platform's
 * `minimumClientVersion`, ANY request answers `426 upgrade_required` with the
 * minimum in the body. `426` outranks every other answer. Requests without the
 * header (Postman, dashboards, curl) pass.
 */
const settingsService = require('../services/settingsService');

const parse = (v) =>
  String(v || '')
    .trim()
    .split('+')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);

/** -1 / 0 / 1 */
const compare = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
};

const versionGate = async (req, res, next) => {
  try {
    const client = req.get('x-client-version');
    if (!client) return next();
    const { minimumClientVersion } = await settingsService.get();
    if (compare(client, minimumClientVersion) < 0) {
      return res.status(426).json({
        error: {
          code: 'upgrade_required',
          message: 'This app version is no longer supported. Please update.',
          minimumVersion: minimumClientVersion,
          reference: req.id,
        },
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { versionGate, compare };
