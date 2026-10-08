/**
 * Real (non-mock) Google ID tokens: what services/googleService.js accepts
 * after google-auth-library has verified signature, audience and expiry, and
 * the shape validator in front of POST /auth/google.
 */
jest.mock('google-auth-library', () => {
  const verifyIdToken = jest.fn();
  return { OAuth2Client: jest.fn(() => ({ verifyIdToken })), verifyIdToken };
});

const { verifyIdToken } = require('google-auth-library');
const f = require('./helpers/factory');
const config = require('../config');
const googleService = require('../services/googleService');

const base = '/api/v1/auth';
const CLIENT_ID = 'web-client-test.apps.googleusercontent.com';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const google = (idToken) => f.api().post(`${base}/google`).set(f.idem()).send({ idToken });
const addr = (p = 'gv') => `${f.uniq(p)}@test.leader`;

const claims = (overrides = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: `sub-${f.uniq()}`,
  email: addr(),
  email_verified: true,
  name: 'Google User',
  ...overrides,
});
const issue = (payload) => verifyIdToken.mockResolvedValueOnce({ getPayload: () => payload });

const previousClientId = config.googleClientId;
beforeAll(() => {
  config.googleClientId = CLIENT_ID;
});
afterAll(() => {
  config.googleClientId = previousClientId;
});
beforeEach(() => verifyIdToken.mockReset());

describe('googleService.verify (real tokens)', () => {
  test('verified address from a Google issuer → identity; audience is the Web client id', async () => {
    const payload = claims({ email: 'Mixed.Case@Test.Leader', iss: 'accounts.google.com' });
    issue(payload);
    const identity = await googleService.verify(TOKEN);
    expect(identity).toEqual({ email: 'mixed.case@test.leader', emailVerified: true, sub: payload.sub, name: 'Google User' });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: TOKEN, audience: CLIENT_ID });
  });

  test.each([
    ['email_verified false', { email_verified: false }],
    ['email_verified missing', { email_verified: undefined }],
    ['foreign issuer', { iss: 'https://evil.example' }],
    ['no subject', { sub: undefined }],
  ])('%s → 401 google_assertion_rejected', async (_label, overrides) => {
    issue(claims(overrides));
    await expect(googleService.verify(TOKEN)).rejects.toMatchObject({ code: 'google_assertion_rejected', statusCode: 401 });
  });

  test('library verification failure (signature / audience / expiry) → 401 google_assertion_rejected', async () => {
    verifyIdToken.mockRejectedValueOnce(new Error('Wrong recipient'));
    await expect(googleService.verify(TOKEN)).rejects.toMatchObject({ code: 'google_assertion_rejected' });
  });
});

describe('POST /auth/google (real tokens)', () => {
  test('an unverified Google address cannot claim an unverified password account', async () => {
    const email = addr('gtake');
    const victim = await f.createAccount({ email, emailVerified: false, status: 'pending_setup', methods: ['password'] });
    issue(claims({ email, email_verified: false }));
    const res = await google(TOKEN).expect(401);
    expect(res.body.error.code).toBe('google_assertion_rejected');
    const fresh = await f.models.Account.findById(victim._id).select('+passwordHash');
    expect(fresh.googleSub).toBeFalsy();
    expect(fresh.passwordHash).toBeTruthy();
  });

  test('a verified new identity → onboarding', async () => {
    const payload = claims();
    issue(payload);
    const res = await google(TOKEN).expect(200);
    expect(res.body.outcome).toBe('onboarding');
    expect(await f.models.Account.countDocuments({ googleSub: payload.sub })).toBe(1);
  });

  test('shape: surrounding whitespace is trimmed; control characters and non-JWT text → 422 before verify', async () => {
    issue(claims());
    await google(`  ${TOKEN}\n`).expect(200);
    for (const bad of [`${TOKEN}\u0000`, TOKEN.replace('.', '.\n'), 'not a token', 'a.b', 'a.b.c.d', 'mock-google:a b@c.co']) {
      const res = await google(bad).expect(422);
      expect(res.body.error.code).toBe('validation');
    }
    expect(verifyIdToken).toHaveBeenCalledTimes(1);
  });
});
