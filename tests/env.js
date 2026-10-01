// Runs before every test file, BEFORE config/index.js is first required.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.PUBLIC_BASE_URL = 'http://localhost:4000';
process.env.DEV_FIXED_OTP = '246810';
process.env.DEV_MAILBOX = 'true';
process.env.ALLOW_MOCK_GOOGLE = 'true';
process.env.GOOGLE_CLIENT_ID = '';
process.env.JOBS_ENABLED = 'false';
process.env.ACCESS_TOKEN_TTL_SECONDS = '900';
