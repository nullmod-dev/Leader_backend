/**
 * Request-scoped tenant context (Node's AsyncLocalStorage).
 *
 * THREAT: a controller that forgets `tenantId: req.tenantId` in ONE query, or
 * builds a filter from the wrong variable, silently reads or writes another
 * team's data (IDOR / broken object-level authorization — OWASP API1:2023).
 *
 * CONTROL: after the auth chain has verified the session and resolved the
 * tenant FROM THE TOKEN, `middlewares/auth.tenantSurface` runs the rest of the
 * request inside `run({ tenantId })`. The tenant-scope plugin
 * (models/plugins/tenantScope.js) reads this context on EVERY database
 * operation and refuses anything that does not stay inside that tenant.
 *
 * The context is carried through `await`, timers and promises automatically,
 * so no function has to pass it along — and no request can change it.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` with `ctx` ({ tenantId, accountId? }) as the current tenant context. */
const run = (ctx, fn) => storage.run(Object.freeze({ ...ctx }), fn);

/** The current context, or undefined outside a tenant request (jobs, platform, seed). */
const get = () => storage.getStore();

/** The current tenant id, or null. */
const currentTenantId = () => {
  const ctx = storage.getStore();
  return ctx && ctx.tenantId ? ctx.tenantId : null;
};

module.exports = { run, get, currentTenantId };
