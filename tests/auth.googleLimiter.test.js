/**
 * POST /auth/google failed-attempt budgets (middlewares/googleSignInLimiter).
 * The app-wide limiters are off in tests, so these build their own instances
 * with the production numbers in front of a stub handler.
 */
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { createGoogleSignInLimiters, deviceKey, ipKey } = require('../middlewares/googleSignInLimiter');

const build = (options) => {
  const limiters = createGoogleSignInLimiters(options);
  const app = express();
  app.set('trust proxy', false);
  app.post('/google', ...limiters, (req, res) => {
    if (req.query.ok === '1') return res.status(200).json({ outcome: 'ready' });
    return res.status(401).json({ error: { code: 'google_assertion_rejected' } });
  });
  return { app, limiters };
};

const attempt = (app, { device, ok = false } = {}) => {
  const req = request(app).post(`/google${ok ? '?ok=1' : ''}`);
  return device === undefined ? req : req.set('X-Device-Id', device);
};

const fakeReq = (ip, device) => ({ ip, get: (name) => (name.toLowerCase() === 'x-device-id' ? device : undefined) });

describe('Google sign-in limiter: per device', () => {
  test('six failures in an hour → the seventh is 429 rate_limited with Retry-After; another device on the same IP is unaffected', async () => {
    const { app } = build();
    const a = crypto.randomUUID();
    for (let i = 0; i < 6; i += 1) await attempt(app, { device: a }).expect(401);
    const refused = await attempt(app, { device: a }).expect(429);
    expect(refused.body.error.code).toBe('rate_limited');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(refused.body.error.retryAfterSeconds).toBe(retryAfter);
    // Even a valid token is refused while the device is over budget.
    await attempt(app, { device: a, ok: true }).expect(429);

    await attempt(app, { device: crypto.randomUUID() }).expect(401);
  });

  test('successful sign-ins never count', async () => {
    const { app } = build();
    const a = crypto.randomUUID();
    for (let i = 0; i < 10; i += 1) await attempt(app, { device: a, ok: true }).expect(200);
    for (let i = 0; i < 6; i += 1) await attempt(app, { device: a }).expect(401);
    await attempt(app, { device: a }).expect(429);
  });

  test('a missing or malformed device id falls back to the IP key', async () => {
    const { app } = build();
    for (let i = 0; i < 3; i += 1) await attempt(app).expect(401);
    await attempt(app, { device: 'not-a-uuid' }).expect(401);
    await attempt(app, { device: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }).expect(401); // v1, not v4
    await attempt(app, { device: `${crypto.randomUUID()}x` }).expect(401);
    await attempt(app).expect(429);
    // An app that sends its id keeps its own budget behind that IP.
    await attempt(app, { device: crypto.randomUUID() }).expect(401);
  });
});

describe('Google sign-in limiter: per IP backstop', () => {
  test('100 failures from one IP with rotating device ids → the 101st is 429; that refusal is not charged to the device', async () => {
    const { app, limiters } = build();
    for (let i = 0; i < 100; i += 1) await attempt(app, { device: crypto.randomUUID() }).expect(401);
    const fresh = crypto.randomUUID();
    const refused = await attempt(app, { device: fresh }).expect(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await limiters[0].getKey(`device:${fresh}`)).totalHits).toBe(0);
  });

  test('a device refused by its own budget does not spend the shared IP budget', async () => {
    const { app, limiters } = build({ deviceLimit: 6, ipLimit: 10 });
    const a = crypto.randomUUID();
    for (let i = 0; i < 6; i += 1) await attempt(app, { device: a }).expect(401);
    for (let i = 0; i < 20; i += 1) await attempt(app, { device: a }).expect(429);
    // Four more failures from other devices still fit the IP's ten.
    for (let i = 0; i < 4; i += 1) await attempt(app, { device: crypto.randomUUID() }).expect(401);
    await attempt(app, { device: crypto.randomUUID() }).expect(429);
    expect(limiters).toHaveLength(2);
  });
});

describe('Google sign-in limiter: keys', () => {
  test('device key: strict UUID v4, lower-cased; anything else → the IP key', () => {
    const id = crypto.randomUUID();
    expect(deviceKey(fakeReq('203.0.113.7', id))).toBe(`device:${id}`);
    expect(deviceKey(fakeReq('203.0.113.7', id.toUpperCase()))).toBe(`device:${id}`);
    expect(deviceKey(fakeReq('203.0.113.7', undefined))).toBe('ip:203.0.113.7');
    expect(deviceKey(fakeReq('203.0.113.7', ''))).toBe('ip:203.0.113.7');
    expect(deviceKey(fakeReq('203.0.113.7', `${id}, ${id}`))).toBe('ip:203.0.113.7');
    expect(deviceKey(fakeReq('203.0.113.7', 'ip:198.51.100.1'))).toBe('ip:203.0.113.7');
  });

  test('IP key: IPv4 and IPv4-mapped as is; IPv6 grouped by /64', () => {
    expect(ipKey(fakeReq('198.51.100.4'))).toBe('ip:198.51.100.4');
    expect(ipKey(fakeReq('::ffff:198.51.100.4'))).toBe('ip:198.51.100.4');
    const a = ipKey(fakeReq('2001:db8:aa:bb:1:2:3:4'));
    expect(a).toBe('ip:2001:db8:aa:bb::/64');
    expect(ipKey(fakeReq('2001:db8:aa:bb::9'))).toBe(a);
    expect(ipKey(fakeReq('2001:0db8:00aa:00bb:ffff::1'))).toBe(a);
    expect(ipKey(fakeReq('2001:db8:aa:bc::1'))).not.toBe(a);
    expect(ipKey(fakeReq('2001:db8::1'))).toBe('ip:2001:db8:0:0::/64');
    expect(ipKey(fakeReq('::1'))).toBe('ip:0:0:0:0::/64');
  });
});
