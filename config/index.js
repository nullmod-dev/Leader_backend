/**
 * Typed configuration, read once from the environment.
 *
 * `server.js` loads `config.env` with dotenv before requiring anything, and the
 * test harness sets `process.env` directly, so this module only *reads*.
 */
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const isTest = env === 'test';

const config = {
  env,
  isProduction,
  isTest,
  port: num(process.env.PORT, 4000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/+$/, ''),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leader',

  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  accessTokenTtlSeconds: num(process.env.ACCESS_TOKEN_TTL_SECONDS, 900),
  onboardingTokenTtlSeconds: num(process.env.ONBOARDING_TOKEN_TTL_SECONDS, 1800),
  refreshTokenTtlDays: num(process.env.REFRESH_TOKEN_TTL_DAYS, 30),
  resetTokenTtlMinutes: num(process.env.RESET_TOKEN_TTL_MINUTES, 15),

  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Never honoured in production, whatever the env file says.
  allowMockGoogle: !isProduction && bool(process.env.ALLOW_MOCK_GOOGLE, false),
  devFixedOtp: isProduction ? '' : process.env.DEV_FIXED_OTP || '',
  devMailbox: !isProduction && bool(process.env.DEV_MAILBOX, false),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Leader <no-reply@leader.local>',
  },

  seedPassword: process.env.SEED_PASSWORD || 'Leader@12345',
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,

  jobsEnabled: bool(process.env.JOBS_ENABLED, !isTest),
  jobsIntervalSeconds: num(process.env.JOBS_INTERVAL_SECONDS, 60),

  // Rate limits are relaxed in tests so suites can hammer auth endpoints.
  rateLimitEnabled: !isTest && bool(process.env.RATE_LIMIT_ENABLED, true),
};

module.exports = config;
