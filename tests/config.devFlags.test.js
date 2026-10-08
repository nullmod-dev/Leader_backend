/**
 * config/index.js — the development flags (fixed OTP 246810, mock Google id
 * tokens, the dev mailbox) are honoured only when NODE_ENV is exactly
 * "development" or "test". Each case loads a fresh copy of the config module
 * against its own environment, with every flag switched on.
 */
const VALID_SECRET = 'a'.repeat(48) + 'b'.repeat(48);
const KEYS = ['NODE_ENV', 'JWT_SECRET', 'DEV_FIXED_OTP', 'ALLOW_MOCK_GOOGLE', 'DEV_MAILBOX'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const loadConfig = (nodeEnv) => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  process.env.JWT_SECRET = VALID_SECRET;
  process.env.DEV_FIXED_OTP = '246810';
  process.env.ALLOW_MOCK_GOOGLE = 'true';
  process.env.DEV_MAILBOX = 'true';
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

describe('dev flags outside development/test', () => {
  test.each(['production', 'staging', 'Development', undefined, ''])('NODE_ENV=%p ignores them', (nodeEnv) => {
    const config = loadConfig(nodeEnv);
    expect(config.devFixedOtp).toBe('');
    expect(config.allowMockGoogle).toBe(false);
    expect(config.devMailbox).toBe(false);
  });
});

describe('dev flags in development/test', () => {
  test.each(['development', 'test'])('NODE_ENV=%p honours them', (nodeEnv) => {
    const config = loadConfig(nodeEnv);
    expect(config.devFixedOtp).toBe('246810');
    expect(config.allowMockGoogle).toBe(true);
    expect(config.devMailbox).toBe(true);
  });

  test.each(['development', 'test'])('NODE_ENV=%p leaves them off when the env file does', (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.JWT_SECRET = VALID_SECRET;
    process.env.DEV_FIXED_OTP = '';
    process.env.ALLOW_MOCK_GOOGLE = 'false';
    process.env.DEV_MAILBOX = 'false';
    let config;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      config = require('../config');
    });
    expect(config.devFixedOtp).toBe('');
    expect(config.allowMockGoogle).toBe(false);
    expect(config.devMailbox).toBe(false);
  });
});
