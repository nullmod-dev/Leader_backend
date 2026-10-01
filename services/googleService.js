/**
 * Google identity assertion → { email, emailVerified, sub, name }.
 *
 * Order:
 *  1. `ALLOW_MOCK_GOOGLE` (never in production) and the token is
 *       `mock-google:<email>`            → verified identity
 *       `mock-google-unverified:<email>` → unverified identity
 *  2. `GOOGLE_CLIENT_ID` configured → google-auth-library verifies the ID
 *     token signature, issuer, expiry and audience. Any failure → 401
 *     `google_assertion_rejected`.
 *  3. Neither → 403 `unsupported_auth_method`.
 *
 * The ID token is a credential: it is never logged or stored.
 */
const config = require('../config');
const AppError = require('../utils/appError');
const { email: normEmail, isEmail } = require('../utils/normalize');

const REJECTED = () => new AppError('google_assertion_rejected', 401, 'The Google sign-in could not be verified.');

const MOCK_RE = /^mock-google(-unverified)?:(.+)$/;

let client = null;
const getClient = () => {
  if (!client) {
    // Lazy: the library is only loaded when a real client id is configured.
    const { OAuth2Client } = require('google-auth-library');
    client = new OAuth2Client(config.googleClientId);
  }
  return client;
};

const truthy = (v) => v === true || v === 'true';

/**
 * @param {string} idToken
 * @returns {Promise<{ email: string, emailVerified: boolean, sub: string, name: string }>}
 */
const verify = async (idToken) => {
  const token = typeof idToken === 'string' ? idToken.trim() : '';
  if (!token) throw REJECTED();

  if (config.allowMockGoogle) {
    const m = MOCK_RE.exec(token);
    if (m) {
      const email = normEmail(m[2]);
      if (!isEmail(email)) throw REJECTED();
      return { email, emailVerified: !m[1], sub: `mock:${email}`, name: email.split('@')[0] };
    }
  }

  if (!config.googleClientId) {
    throw new AppError('unsupported_auth_method', 403, 'Google sign-in is not configured on this server.');
  }

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken: token, audience: config.googleClientId });
    payload = ticket.getPayload();
  } catch (e) {
    throw REJECTED();
  }
  if (!payload || !payload.sub || !payload.email || !isEmail(payload.email)) throw REJECTED();
  return {
    email: normEmail(payload.email),
    emailVerified: truthy(payload.email_verified),
    sub: String(payload.sub),
    name: payload.name || '',
  };
};

module.exports = { verify };
