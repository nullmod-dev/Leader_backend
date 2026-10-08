/**
 * E1 — the two remaining hardening items:
 *   - /verification/verify and /verification/resend sit behind the same
 *     per-IP budget as sign-up and sign-in (authLimiter);
 *   - production without an SMTP host says so once at boot, naming the
 *     setting and never a value.
 *
 * The limiter itself is a pass-through in tests (RATE_LIMIT_ENABLED), so the
 * route test proves the wiring: the very authLimiter the other public auth
 * endpoints use, ahead of the idempotency replay.
 */
const router = require('../routes/authRoutes');
const { authLimiter } = require('../middlewares/rateLimit');
const emailService = require('../services/emailService');

const handlersOf = (path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  if (!layer) throw new Error(`no POST ${path}`);
  return layer.route.stack.map((s) => s.handle);
};

describe('authLimiter on verification', () => {
  test.each(['/verification/verify', '/verification/resend'])('%s is budgeted per IP', (path) => {
    const handlers = handlersOf(path);
    expect(handlers[0]).toBe(authLimiter);
  });

  test('sign-up and sign-in keep the same budget', () => {
    expect(handlersOf('/sign-up')).toContain(authLimiter);
    expect(handlersOf('/sign-in')).toContain(authLimiter);
  });
});

describe('emailService.warnIfUndeliverable', () => {
  test('production without an SMTP host warns once, with no config value', () => {
    const log = jest.fn();
    expect(emailService.warnIfUndeliverable({ isProduction: true, host: '', log })).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0];
    expect(message).toContain('SMTP_HOST');
    expect(message).not.toMatch(/@|:\/\/|\d{3,}/);
  });

  test('says nothing with a host, or outside production', () => {
    const log = jest.fn();
    expect(emailService.warnIfUndeliverable({ isProduction: true, host: 'smtp.example.org', log })).toBe(false);
    expect(emailService.warnIfUndeliverable({ isProduction: false, host: '', log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
