/**
 * POST /auth/email-status and POST /auth/sign-in/code (email-only sign-in),
 * plus their device/IP budgets (middlewares/emailEntryLimiter).
 */
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const f = require('./helpers/factory');
const authorizationService = require('../services/authorizationService');
const { createEmailEntryLimiters } = require('../middlewares/emailEntryLimiter');

const base = '/api/v1/auth';
const CODE = '246810';
const PW = 'Str0ng-passw0rd';

const status = (email) => f.api().post(`${base}/email-status`).send({ email });
const codeFor = (email) => f.api().post(`${base}/sign-in/code`).send({ email });
const verify = (challengeId, code = CODE) => f.api().post(`${base}/verification/verify`).set(f.device()).set(f.idem()).send({ challengeId, code });
const google = (idToken) => f.api().post(`${base}/google`).set(f.device()).set(f.idem()).send({ idToken });
const me = (token) => f.api().get(`${base}/me`).set(f.auth(token));
const addr = (p = 'ee') => `${f.uniq(p)}@test.leader`;

const CHALLENGE_KEYS = ['attemptsRemaining', 'challengeId', 'codeLength', 'expiresAt', 'maskedEmail', 'purpose', 'resendAvailableAt'];

const expectSignInChallenge = (res) => {
  expect(res.status).toBe(202);
  expect(Object.keys(res.body).sort()).toEqual(CHALLENGE_KEYS);
  expect(res.body.purpose).toBe('sign_in');
  expect(res.body.code).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain(CODE);
};

const mails = (email) => f.models.DevMail.countDocuments({ to: email });

describe('POST /auth/email-status', () => {
  test('a verified account → registered; the body is { status } only', async () => {
    const account = await f.createAccount({ email: addr('reg') });
    const res = await status(account.email.toUpperCase()).expect(200);
    expect(res.body).toEqual({ status: 'registered' });
  });

  test('a provisioned seat nobody claimed, or a pending invitation → invited', async () => {
    const tenant = await f.createTenant();
    const seatEmail = addr('seat');
    await authorizationService.provisionSeatAccount({ tenant, name: 'هدى', email: seatEmail, kind: 'initial_seat' });
    expect((await status(seatEmail).expect(200)).body).toEqual({ status: 'invited' });

    const invitedEmail = addr('inv');
    await f.models.Authorization.create({
      tenantId: String(tenant._id),
      kind: 'simple_admin',
      email: invitedEmail,
      role: 'admin',
      expiresAt: new Date(Date.now() + 86400000),
    });
    expect((await status(invitedEmail).expect(200)).body).toEqual({ status: 'invited' });
  });

  test('unknown, an unverified sign-up, an expired invitation and a customer demo → new', async () => {
    const unverified = addr('unv');
    await f.api().post(`${base}/sign-up`).set(f.idem()).send({ email: unverified, password: PW }).expect(202);
    const expired = addr('exp');
    const tenant = await f.createTenant();
    await f.models.Authorization.create({
      tenantId: String(tenant._id),
      kind: 'simple_admin',
      email: expired,
      role: 'admin',
      expiresAt: new Date(Date.now() - 1000),
    });
    const demo = await f.createAccount({ email: addr('demo'), role: 'customer_demo', setupCompleted: true });

    for (const email of [addr('none'), unverified, expired, demo.email]) {
      expect((await status(email).expect(200)).body).toEqual({ status: 'new' });
    }
  });

  test('a malformed or missing address → 422 validation', async () => {
    expect((await status('not-an-email').expect(422)).body.error.code).toBe('validation');
    await f.api().post(`${base}/email-status`).send({}).expect(422);
  });
});

describe('POST /auth/sign-in/code', () => {
  test('a registered unfinished account: the mailed code signs in → onboarding', async () => {
    const account = await f.createAccount({ email: addr('code'), status: 'pending_setup' });
    const res = await codeFor(account.email);
    expectSignInChallenge(res);
    const mail = await f.models.DevMail.findOne({ to: account.email }).sort({ createdAt: -1 });
    expect(mail.kind).toBe('signInCode');
    expect(await f.latestCode(account.email)).toBe(CODE);

    const done = await verify(res.body.challengeId).expect(200);
    expect(done.body.outcome).toBe('onboarding');
    expect(done.body.snapshot.accountId).toBe(String(account._id));
  });

  test('a finished administrator → ready', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant, { email: addr('main') });
    const res = await codeFor(account.email);
    expectSignInChallenge(res);
    const done = await verify(res.body.challengeId).expect(200);
    expect(done.body.outcome).toBe('ready');
    expect((await me(done.body.accessToken).expect(200)).body.access.mfaRequired).toBe(false);
  });

  test('MFA still runs afterwards: the code opens a session that is mfaRequired', async () => {
    const tenant = await f.createTenant();
    const { account } = await f.mainAdmin(tenant, { email: addr('mfa'), mfa: { enabled: true, enabledAt: new Date() } });
    const res = await codeFor(account.email);
    const done = await verify(res.body.challengeId).expect(200);
    expect(done.body.outcome).toBe('ready');
    expect((await me(done.body.accessToken).expect(200)).body.access.mfaRequired).toBe(true);
    const blocked = await f.api().get(`${base}/sessions`).set(f.auth(done.body.accessToken)).expect(403);
    expect(blocked.body.error.code).toBe('mfa_required');
  });

  test('unknown, unverified, invited and super_admin addresses get a decoy: same shape, no mail, never verifies', async () => {
    const tenant = await f.createTenant();
    const seatEmail = addr('dseat');
    await authorizationService.provisionSeatAccount({ tenant, name: 'هدى', email: seatEmail, kind: 'initial_seat' });
    const unverified = addr('dunv');
    await f.api().post(`${base}/sign-up`).set(f.idem()).send({ email: unverified, password: PW }).expect(202);
    const platform = await f.createAccount({ email: addr('dsa'), role: 'super_admin', setupCompleted: true });

    for (const email of [addr('dnone'), unverified, seatEmail, platform.email]) {
      const before = await mails(email);
      const res = await codeFor(email);
      expectSignInChallenge(res);
      expect(await mails(email)).toBe(before);
      const ch = await f.models.VerificationChallenge.findById(res.body.challengeId);
      expect(ch).toMatchObject({ decoy: true, accountId: null });
      const bad = await verify(res.body.challengeId).expect(422);
      expect(bad.body.error.code).toBe('verification_code_invalid');
    }
  });

  test('cooldown: a repeat inside it answers the SAME challenge with no new mail; after it, a new code ends the old one', async () => {
    const account = await f.createAccount({ email: addr('cool') });
    const first = await codeFor(account.email).expect(202);
    const second = await codeFor(account.email).expect(202);
    expect(second.body.challengeId).toBe(first.body.challengeId);
    expect(await mails(account.email)).toBe(1);

    await f.models.VerificationChallenge.updateOne({ _id: first.body.challengeId }, { $set: { resendAvailableAt: new Date(Date.now() - 1000) } });
    const third = await codeFor(account.email).expect(202);
    expect(third.body.challengeId).not.toBe(first.body.challengeId);
    expect(await mails(account.email)).toBe(2);
    await verify(first.body.challengeId).expect(409);
    await verify(third.body.challengeId).expect(200);
  });

  test('decoys are reused inside the cooldown too', async () => {
    const email = addr('dcool');
    const first = await codeFor(email).expect(202);
    const second = await codeFor(email).expect(202);
    expect(second.body.challengeId).toBe(first.body.challengeId);
  });

  test('never links or replaces a Google identity, and never reuses a Google sign-in challenge', async () => {
    const email = addr('gkeep');
    const account = await f.createAccount({ email, googleSub: 'mock:original', methods: ['google'] });
    // A pending Google sign-in for a password-only account would link on its code;
    // the email-code request must not hand that challenge back.
    const pw = await f.createAccount({ email: addr('gpend') });
    const pending = await google(`mock-google:${pw.email}`).expect(200);
    const viaCode = await codeFor(pw.email).expect(202);
    expect(viaCode.body.challengeId).not.toBe(pending.body.challenge.challengeId);
    await verify(viaCode.body.challengeId).expect(200);
    expect((await f.models.Account.findById(pw._id)).googleSub).toBeUndefined();

    const res = await codeFor(email).expect(202);
    await verify(res.body.challengeId).expect(200);
    const fresh = await f.models.Account.findById(account._id);
    expect(fresh.googleSub).toBe('mock:original');
    expect([...fresh.methods]).toEqual([...account.methods]);
  });

  test('a malformed address → 422 validation', async () => {
    expect((await codeFor('nope').expect(422)).body.error.code).toBe('validation');
  });
});

describe('email entry budgets', () => {
  const build = (options) => {
    const limiters = createEmailEntryLimiters(options);
    const app = express();
    app.set('trust proxy', false);
    app.post('/entry', ...limiters, (req, res) => res.status(200).json({ status: 'new' }));
    return app;
  };
  const hit = (app, device) => (device === undefined ? request(app).post('/entry') : request(app).post('/entry').set('X-Device-Id', device));

  test('20 requests per device per hour, successes included; the 21st is 429 rate_limited with Retry-After', async () => {
    const app = build();
    const a = crypto.randomUUID();
    for (let i = 0; i < 20; i += 1) await hit(app, a).expect(200);
    const refused = await hit(app, a).expect(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(3500);
    await hit(app, crypto.randomUUID()).expect(200);
  });

  test('the IP backstop refuses a client that rotates device ids', async () => {
    const app = build({ ipLimit: 5 });
    for (let i = 0; i < 5; i += 1) await hit(app, crypto.randomUUID()).expect(200);
    await hit(app, crypto.randomUUID()).expect(429);
  });

  test('defaults are 20 per device and 200 per IP', async () => {
    const app = build({ deviceLimit: 1000 });
    for (let i = 0; i < 200; i += 1) await hit(app, crypto.randomUUID()).expect(200);
    await hit(app, crypto.randomUUID()).expect(429);
  });
});
