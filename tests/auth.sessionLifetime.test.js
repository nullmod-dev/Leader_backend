/**
 * Session lifetime: a sliding idle limit (REFRESH_TOKEN_TTL_DAYS, slid by
 * every refresh and GET /auth/me) under an absolute one (SESSION_MAX_DAYS).
 */
const f = require('./helpers/factory');
const config = require('../config');

const base = '/api/v1/auth';
const DAY = 86400000;
const refresh = (refreshToken) => f.api().post(`${base}/refresh`).send({ refreshToken });
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));
const near = (a, b, slack = 5000) => expect(Math.abs(new Date(a).getTime() - b)).toBeLessThan(slack);

const signedIn = async () => {
  const tenant = await f.createTenant();
  return f.mainAdmin(tenant);
};

describe('session lifetime', () => {
  test('a new session: idle deadline now + REFRESH_TOKEN_TTL_DAYS, absolute end now + SESSION_MAX_DAYS', async () => {
    const { session } = await signedIn();
    near(session.refreshExpiresAt, Date.now() + config.refreshTokenTtlDays * DAY);
    near(session.absoluteExpiresAt, Date.now() + config.sessionMaxDays * DAY);
  });

  test('a refresh slides the idle deadline and keeps the sessionId', async () => {
    const { session, refreshToken } = await signedIn();
    await f.models.Session.updateOne({ _id: session._id }, { $set: { refreshExpiresAt: new Date(Date.now() + DAY) } });
    const res = await refresh(refreshToken).expect(200);
    expect(res.body.sessionId).toBe(String(session._id));
    near((await f.models.Session.findById(session._id)).refreshExpiresAt, Date.now() + config.refreshTokenTtlDays * DAY);
  });

  test('GET /auth/me slides the idle deadline too', async () => {
    const { session, token } = await signedIn();
    await f.models.Session.updateOne({ _id: session._id }, { $set: { refreshExpiresAt: new Date(Date.now() + DAY) } });
    await me(token).expect(200);
    near((await f.models.Session.findById(session._id)).refreshExpiresAt, Date.now() + config.refreshTokenTtlDays * DAY);
  });

  test('sliding never passes the absolute end, and the session ends there', async () => {
    const { session, refreshToken } = await signedIn();
    const end = new Date(Date.now() + 2 * DAY);
    await f.models.Session.updateOne({ _id: session._id }, { $set: { absoluteExpiresAt: end, refreshExpiresAt: new Date(Date.now() + DAY) } });
    const res = await refresh(refreshToken).expect(200);
    near((await f.models.Session.findById(session._id)).refreshExpiresAt, end.getTime(), 1000);

    await f.models.Session.updateOne({ _id: session._id }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000), refreshExpiresAt: new Date(Date.now() - 1000) } });
    const gone = await refresh(res.body.refreshToken).expect(401);
    expect(gone.body.error.code).toBe('authentication_expired');
  });

  test('idle past the deadline → the session has ended', async () => {
    const { session, refreshToken, token } = await signedIn();
    await f.models.Session.updateOne({ _id: session._id }, { $set: { refreshExpiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(refreshToken).expect(401)).body.error.code).toBe('authentication_expired');
    expect((await me(token).expect(401)).body.error.code).toBe('authentication_expired');
  });

  test('a session that predates absoluteExpiresAt is capped at createdAt + SESSION_MAX_DAYS', async () => {
    const { session, refreshToken } = await signedIn();
    const createdAt = new Date(Date.now() - (config.sessionMaxDays * DAY - DAY));
    await f.models.Session.collection.updateOne(
      { _id: session._id },
      { $unset: { absoluteExpiresAt: '' }, $set: { createdAt, refreshExpiresAt: new Date(Date.now() + 3600000) } },
    );
    await refresh(refreshToken).expect(200);
    near((await f.models.Session.findById(session._id)).refreshExpiresAt, createdAt.getTime() + config.sessionMaxDays * DAY, 1000);
  });
});
