/**
 * config/index.js — JWT_SECRET is required outside development/test, and the
 * dev fallback is never used anywhere else. Each case loads a fresh copy of
 * the config module against its own environment.
 */
const DEV_FALLBACK = 'dev-only-secret-change-me-dev-only-secret';
const VALID = 'a'.repeat(48) + 'b'.repeat(48);

const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };

const loadConfig = ({ nodeEnv, secret }) => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (secret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = secret;
  let config;
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    config = require('../config');
  });
  return config;
};

afterEach(() => {
  jest.resetModules();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('JWT_SECRET outside development/test', () => {
  test.each(['production', 'staging', undefined, ''])('NODE_ENV=%p without a secret refuses to load', (nodeEnv) => {
    expect(() => loadConfig({ nodeEnv, secret: undefined })).toThrow(/JWT_SECRET is required/);
  });

  test('production with a short secret refuses to load', () => {
    expect(() => loadConfig({ nodeEnv: 'production', secret: 'x'.repeat(31) })).toThrow(/JWT_SECRET is too short/);
  });

  test.each([
    DEV_FALLBACK,
    'change-me-dev-only-secret-at-least-32-characters-long',
    'change-me-min-32-chars',
    'test-secret-test-secret-test-secret-123456',
  ])('production with a known development value %p refuses to load', (secret) => {
    expect(() => loadConfig({ nodeEnv: 'production', secret })).toThrow(/JWT_SECRET/);
  });

  test('the error never contains the secret value', () => {
    const secret = 'short-secret-value';
    let message = '';
    try {
      loadConfig({ nodeEnv: 'production', secret });
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).not.toContain(secret);
  });

  test('production with a valid secret loads and uses it', () => {
    const config = loadConfig({ nodeEnv: 'production', secret: VALID });
    expect(config.isProduction).toBe(true);
    expect(config.jwtSecret).toBe(VALID);
  });
});

describe('JWT_SECRET in development/test', () => {
  test.each(['development', 'test'])('NODE_ENV=%p without a secret uses the dev fallback', (nodeEnv) => {
    expect(loadConfig({ nodeEnv, secret: undefined }).jwtSecret).toBe(DEV_FALLBACK);
  });

  test.each(['development', 'test'])('NODE_ENV=%p keeps a supplied secret', (nodeEnv) => {
    expect(loadConfig({ nodeEnv, secret: 'local-only' }).jwtSecret).toBe('local-only');
  });
});
