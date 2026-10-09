/**
 * config/index.js — CORS_ORIGINS. The mobile app sends no Origin; the list
 * only decides which *browser* origins may call the API. Unset, it is open in
 * development/test and closed everywhere else.
 */
const f = require('./helpers/factory');

const VALID_SECRET = 'a'.repeat(48) + 'b'.repeat(48);
const KEYS = ['NODE_ENV', 'JWT_SECRET', 'CORS_ORIGINS'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const loadConfig = (nodeEnv, origins) => {
  process.env.NODE_ENV = nodeEnv;
  process.env.JWT_SECRET = VALID_SECRET;
  if (origins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = origins;
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

test('production with nothing set allows no browser origin', () => {
  expect(loadConfig('production').corsOrigins).toEqual([]);
  expect(loadConfig('production', '').corsOrigins).toEqual([]);
});

test('development and test default to any origin', () => {
  expect(loadConfig('development').corsOrigins).toEqual(['*']);
  expect(loadConfig('test').corsOrigins).toEqual(['*']);
});

test('a named list is used as written', () => {
  expect(loadConfig('production', 'https://admin.leader.app, https://x.test').corsOrigins).toEqual([
    'https://admin.leader.app',
    'https://x.test',
  ]);
});

test('a browser preflight may send X-Device-Id', async () => {
  const res = await f
    .api()
    .options('/api/v1/auth/me')
    .set('Origin', 'https://dashboard.test')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'authorization,x-device-id');
  expect(res.headers['access-control-allow-headers']).toMatch(/X-Device-Id/i);
});
