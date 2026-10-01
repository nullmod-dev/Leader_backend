/**
 * Commerce checkout → manual payment confirmation (Point 19, §18.5/§18.8):
 * the server quotes, the order snapshots it, and ONLY the confirmation
 * redeems the coupon and activates the subscription — atomically, once.
 */
const f = require('./helpers/factory');

let platform;
let tenant;
let main;
let simple;

const checkout = (token, body, headers = f.idem()) => f.api().post('/api/v1/billing/checkout').set(f.auth(token)).set(headers).send(body);
const confirm = (orderId, body = {}, headers = f.idem()) =>
  f.api().post(`/api/v1/platform/billing/orders/${orderId}/confirm`).set(f.auth(platform.token)).set(headers).send(body);
const cancel = (orderId) => f.api().post(`/api/v1/platform/billing/orders/${orderId}/cancel`).set(f.auth(platform.token)).set(f.idem()).send({});
const coupon = (overrides = {}) =>
  f.models.Coupon.create({ code: `C${f.uniq().toUpperCase()}`, target: 'monthly', discount: { kind: 'fixed_final_price', finalPrice: { amount: 200, currency: 'USD' } }, enabled: true, ...overrides });

beforeAll(async () => {
  platform = await f.superAdmin();
  ({ tenant, main } = await f.tenantWithMainAdmin());
  simple = await f.simpleAdmin(tenant);
});

describe('POST /billing/checkout', () => {
  test('authorization: Main Admin only; platform and demo have no tenant context', async () => {
    const sub = await checkout(simple.token, { billingOptionId: 'monthly' }).expect(403);
    expect(sub.body.error.code).toBe('not_permitted');
    const plat = await checkout(platform.token, { billingOptionId: 'monthly' }).expect(403);
    expect(plat.body.error.code).toBe('tenant_context_unavailable');
    await f.api().post('/api/v1/billing/checkout').send({ billingOptionId: 'monthly' }).expect(401);
  });

  test('validation and Idempotency-Key', async () => {
    const res = await checkout(main.token, { billingOptionId: 'yearly' }).expect(422);
    expect(res.body.error.fields).toHaveProperty('billingOptionId');
    const noKey = await f.api().post('/api/v1/billing/checkout').set(f.auth(main.token)).send({ billingOptionId: 'monthly' }).expect(422);
    expect(noKey.body.error.fields).toHaveProperty(['Idempotency-Key']);
  });

  test('server-computed snapshot, manual payment instructions, nothing redeemed', async () => {
    const c = await coupon({ maxUses: 5 });
    const res = await checkout(main.token, {
      billingOptionId: 'monthly',
      couponCode: c.code.toLowerCase(),
      finalPrice: { amount: 1, currency: 'USD' }, // never trusted — stripped
    }).expect(201);
    expect(res.body.order).toMatchObject({
      billingOptionId: 'monthly',
      months: 1,
      basePrice: { amount: 600, currency: 'USD' },
      finalPrice: { amount: 200, currency: 'USD' },
      promotion: { source: 'coupon', id: String(c._id), code: c.code, label: c.code },
      planId: 'mtm_standard',
      status: 'pending_payment',
    });
    expect(res.body.order.id).toMatch(/^bo_/);
    expect(res.body.order).not.toHaveProperty('paidAt');
    expect(res.body.payment).toMatchObject({ provider: 'manual', status: 'pending_payment' });
    expect(res.body.payment.instructions).toMatch(/ليدر/);
    expect(res.body.payment.support).toHaveProperty('email');
    expect((await f.models.Coupon.findById(c._id)).usedCount).toBe(0);
    expect(await f.models.CouponRedemption.countDocuments({ couponId: String(c._id) })).toBe(0);
  });

  test('no coupon → base price (or the live offer); invalid coupons refuse with validate codes', async () => {
    const plain = await checkout(main.token, { billingOptionId: 'twelve_months' }).expect(201);
    expect(plain.body.order).toMatchObject({ finalPrice: { amount: 4000 }, promotion: null, months: 12 });

    const expired = await coupon({ expiresAt: new Date(Date.now() - 1000) });
    const r1 = await checkout(main.token, { billingOptionId: 'monthly', couponCode: expired.code }).expect(422);
    expect(r1.body.error.code).toBe('coupon_expired');
    const r2 = await checkout(main.token, { billingOptionId: 'monthly', couponCode: 'NOT-A-COUPON' }).expect(422);
    expect(r2.body.error.code).toBe('coupon_not_found');
    const three = await coupon({ target: 'three_months', discount: { kind: 'percentage', percent: 10 } });
    const r3 = await checkout(main.token, { billingOptionId: 'monthly', couponCode: three.code }).expect(422);
    expect(r3.body.error).toMatchObject({ code: 'coupon_not_eligible', couponTarget: 'three_months' });
    const someoneElse = await coupon({ assignment: { kind: 'account', accountId: String(simple.account._id) } });
    const r4 = await checkout(main.token, { billingOptionId: 'monthly', couponCode: someoneElse.code }).expect(422);
    expect(r4.body.error.code).toBe('coupon_not_assigned');
  });

  test('GET /billing/orders and /billing/orders/:id (tenant-scoped)', async () => {
    const list = await f.api().get('/api/v1/billing/orders').set(f.auth(main.token)).expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const times = list.body.map((o) => o.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const one = await f.api().get(`/api/v1/billing/orders/${list.body[0].id}`).set(f.auth(main.token)).expect(200);
    expect(one.body.id).toBe(list.body[0].id);
    expect(one.body).not.toHaveProperty('tenantId');

    const other = await f.tenantWithMainAdmin();
    const foreign = await f.api().get(`/api/v1/billing/orders/${list.body[0].id}`).set(f.auth(other.main.token)).expect(404);
    expect(foreign.body.error.code).toBe('not_found');
    expect((await f.api().get('/api/v1/billing/orders').set(f.auth(other.main.token)).expect(200)).body).toEqual([]);
    await f.api().get('/api/v1/billing/orders').set(f.auth(simple.token)).expect(403);
  });
});

describe('platform billing', () => {
  test('GET /platform/billing/orders: tenant name, filters, cursor; platform only', async () => {
    const res = await f.api().get('/api/v1/platform/billing/orders').set(f.auth(platform.token)).expect(200);
    expect(res.body.items[0]).toMatchObject({ tenantId: String(tenant._id), tenantName: tenant.displayName, status: 'pending_payment' });
    const filtered = await f.api().get('/api/v1/platform/billing/orders').query({ status: 'paid', tenantId: String(tenant._id) }).set(f.auth(platform.token)).expect(200);
    expect(filtered.body.items.every((o) => o.status === 'paid')).toBe(true);
    const page1 = await f.api().get('/api/v1/platform/billing/orders?limit=1').set(f.auth(platform.token)).expect(200);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await f.api().get('/api/v1/platform/billing/orders').query({ limit: 1, cursor: page1.body.nextCursor }).set(f.auth(platform.token)).expect(200);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    await f.api().get('/api/v1/platform/billing/orders?status=refunded').set(f.auth(platform.token)).expect(422);
    await f.api().get('/api/v1/platform/billing/orders').set(f.auth(main.token)).expect(403);
  });

  test('confirm: redeems once, pays, activates/renews; a second confirm → 409', async () => {
    const t = await f.tenantWithMainAdmin();
    const renewsBefore = t.tenant.subscription.renewsAt;
    const c = await coupon({ maxUses: 3 });
    const { body } = await checkout(t.main.token, { billingOptionId: 'monthly', couponCode: c.code }).expect(201);

    const key = f.idem();
    const res = await confirm(body.order.id, { paymentReference: 'حوالة 7781' }, key).expect(200);
    expect(res.body.order).toMatchObject({ id: body.order.id, status: 'paid', tenantId: String(t.tenant._id), paymentReference: 'حوالة 7781' });
    expect(typeof res.body.order.paidAt).toBe('string');
    expect(res.body.subscription).toMatchObject({
      status: 'active',
      planId: 'mtm_standard',
      version: t.tenant.subscription.version + 1,
      trialEndsAt: null,
      graceEndsAt: null,
      lastPayment: { billingOrderId: body.order.id, billingOptionId: 'monthly', amount: { amount: 200, currency: 'USD' } },
    });
    // Active subscription with a future renewal → extended from that renewal by one month.
    const expected = new Date(renewsBefore);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(Math.abs(new Date(res.body.subscription.renewsAt) - expected)).toBeLessThan(3 * 86400000);
    expect(new Date(res.body.subscription.renewsAt) > renewsBefore).toBe(true);

    expect((await f.models.Coupon.findById(c._id)).usedCount).toBe(1);
    expect(await f.models.CouponRedemption.countDocuments({ billingOrderId: body.order.id })).toBe(1);
    expect(await f.models.TenantStatusEvent.countDocuments({ tenantId: String(t.tenant._id), type: 'subscription_activated' })).toBe(1);
    const paidAudit = await f.models.AuditEvent.findOne({ action: 'billing_order_paid', 'target.id': body.order.id });
    expect(paidAudit).toMatchObject({ category: 'commerce', actor: { kind: 'platform_administrator' } });
    expect(await f.models.AuditEvent.countDocuments({ action: 'commerce_coupon_redeemed', 'target.id': String(c._id) })).toBe(1);

    // Replay with the same key → same answer, no new effect.
    const replay = await confirm(body.order.id, { paymentReference: 'حوالة 7781' }, key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // A new confirm → 409 conflict, nothing redeemed twice.
    const again = await confirm(body.order.id).expect(409);
    expect(again.body.error.code).toBe('conflict');
    expect((await f.models.Coupon.findById(c._id)).usedCount).toBe(1);
    expect(await f.models.CouponRedemption.countDocuments({ couponId: String(c._id) })).toBe(1);

    const fresh = await f.models.SaasTenant.findById(t.tenant._id);
    expect(fresh.subscription.lastPayment.amount).toBe(200);
  });

  test('confirm on a trial tenant starts the paid period now', async () => {
    const t = await f.tenantWithMainAdmin({
      subscription: { status: 'trial', planId: null, version: 3, trialEndsAt: new Date(Date.now() + 5 * 86400000) },
    });
    const { body } = await checkout(t.main.token, { billingOptionId: 'three_months' }).expect(201);
    expect(body.order.planId).toBe('mtm_standard');
    const res = await confirm(body.order.id).expect(200);
    expect(res.body.subscription).toMatchObject({ status: 'active', planId: 'mtm_standard', version: 4, trialEndsAt: null });
    const days = (new Date(res.body.subscription.renewsAt) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(93);
    const audit = await f.models.AuditEvent.findOne({ action: 'billing_order_paid', 'target.id': body.order.id });
    expect(audit.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['billing_order_status', 'subscription_status', 'plan_assignment']));
  });

  test('coupon exhausted at confirmation → 409 coupon_exhausted, order stays pending', async () => {
    const c = await coupon({ maxUses: 1 });
    const first = await checkout(main.token, { billingOptionId: 'monthly', couponCode: c.code }).expect(201);
    const second = await checkout(main.token, { billingOptionId: 'monthly', couponCode: c.code }).expect(201);
    await confirm(first.body.order.id).expect(200);
    const res = await confirm(second.body.order.id).expect(409);
    expect(res.body.error.code).toBe('coupon_exhausted');
    expect((await f.models.BillingOrder.findById(second.body.order.id)).status).toBe('pending_payment');
    expect((await f.models.Coupon.findById(c._id)).usedCount).toBe(1);
    // …and the exhausted coupon can no longer be checked out.
    const r = await checkout(main.token, { billingOptionId: 'monthly', couponCode: c.code }).expect(422);
    expect(r.body.error.code).toBe('coupon_exhausted');
  });

  test('cancel: pending only (+ audit); confirm after cancel → 409; unknown → 404', async () => {
    const { body } = await checkout(main.token, { billingOptionId: 'six_months' }).expect(201);
    const res = await cancel(body.order.id).expect(200);
    expect(res.body).toMatchObject({ status: 'cancelled' });
    expect(typeof res.body.cancelledAt).toBe('string');
    expect(await f.models.AuditEvent.countDocuments({ action: 'billing_order_cancelled', 'target.id': body.order.id })).toBe(1);
    expect((await cancel(body.order.id).expect(409)).body.error.code).toBe('conflict');
    expect((await confirm(body.order.id).expect(409)).body.error.code).toBe('conflict');
    expect((await confirm('bo_nope').expect(404)).body.error.code).toBe('not_found');
    await f.api().post(`/api/v1/platform/billing/orders/${body.order.id}/cancel`).set(f.auth(platform.token)).send({}).expect(422);
  });
});
