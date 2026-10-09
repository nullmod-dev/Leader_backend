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
// Read raw: `env` above defaults an unset NODE_ENV to development, and an unset
// NODE_ENV must not unlock anything development-only.
const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

/**
 * The token-signing secret. The dev fallback is honoured only when NODE_ENV is
 * explicitly "development" or "test"; anywhere else (production, staging, or
 * NODE_ENV left unset) JWT_SECRET must be supplied, at least 32 characters and
 * not a value this repository ships. The error names the variable, never its
 * value.
 */
const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret';
const KNOWN_JWT_SECRETS = new Set([
  DEV_JWT_SECRET,
  'change-me-dev-only-secret-at-least-32-characters-long',
  'change-me-min-32-chars',
  'test-secret-test-secret-test-secret-123456',
]);
const resolveJwtSecret = () => {
  const secret = process.env.JWT_SECRET || '';
  if (isDevOrTest) {
    return secret || DEV_JWT_SECRET;
  }
  if (!secret) {
    throw new Error('JWT_SECRET is required unless NODE_ENV is "development" or "test". Generate one with: openssl rand -hex 48');
  }
  if (secret.length < 32 || KNOWN_JWT_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET is too short (min 32) or a known development value. Generate one with: openssl rand -hex 48');
  }
  return secret;
};

const config = {
  env,
  isProduction,
  isTest,
  port: num(process.env.PORT, 4000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/+$/, ''),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leader',

  jwtSecret: resolveJwtSecret(),
  accessTokenTtlSeconds: num(process.env.ACCESS_TOKEN_TTL_SECONDS, 900),
  onboardingTokenTtlSeconds: num(process.env.ONBOARDING_TOKEN_TTL_SECONDS, 1800),
  // Idle limit: each refresh and GET /auth/me slides the session to now + this many days.
  refreshTokenTtlDays: num(process.env.REFRESH_TOKEN_TTL_DAYS, 7),
  // Absolute limit: no session outlives sign-in + this many days, however active.
  sessionMaxDays: num(process.env.SESSION_MAX_DAYS, 30),
  // Device trust: trusted devices per account, and how long a new device's
  // sessions stay restricted unless a trusted device answers "Yes".
  trustedDevicesMax: num(process.env.TRUSTED_DEVICES_MAX, 3),
  newDeviceRestrictHours: num(process.env.NEW_DEVICE_RESTRICT_HOURS, 6),
  resetTokenTtlMinutes: num(process.env.RESET_TOKEN_TTL_MINUTES, 15),

  // Browser origins allowed to call the API. The mobile app sends no Origin
  // and is unaffected. Unset: any origin in development/test, and NONE
  // anywhere else — a production server opens itself to a web dashboard by
  // naming it, never by default.
  corsOrigins: (process.env.CORS_ORIGINS ?? (isDevOrTest ? '*' : ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Honoured only when NODE_ENV is exactly "development" or "test" — never in
  // production, staging, or with NODE_ENV unset, whatever the env file says.
  allowMockGoogle: isDevOrTest && bool(process.env.ALLOW_MOCK_GOOGLE, false),
  devFixedOtp: isDevOrTest ? process.env.DEV_FIXED_OTP || '' : '',
  devMailbox: isDevOrTest && bool(process.env.DEV_MAILBOX, false),

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
