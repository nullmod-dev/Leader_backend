/**
 * Commerce (Point 19): pricing math to the cent, no stacking, public reads,
 * quotes, coupon validation (a READ — never consumes) and the platform
 * offer/coupon management.
 */
const f = require('./helpers/factory');
const pricing = require('../services/pricingService');

const P = '/api/v1/platform/commerce';

let platform;
let main;
let simple;

const createOffer = (body) => f.api().post(`${P}/offers`).set(f.auth(platform.token)).set(f.idem()).send(body);
const createCoupon = (body) => f.api().post(`${P}/coupons`).set(f.auth(platform.token)).set(f.idem()).send(body);
const code = () => `T${f.uniq().toUpperCase()}`;
const validate = (token, body) => f.api().post('/api/v1/pricing/coupons/validate').set(f.auth(token)).send(body);
const pct = (percent) => ({ kind: 'percentage', percent });
const fixed = (amount) => ({ kind: 'fixed_final_price', finalPrice: { amount, currency: 'USD' } });

beforeAll(async () => {
  platform = await f.superAdmin();
  const t = await f.tenantWithMainAdmin();
  main = t.main;
  simple = await f.simpleAdmin(t.tenant);
});

describe('pricing math (pure)', () => {
  test('percentage rounds half-up on the discount', () => {
    expect(pricing.percentageFinal(1400, 10)).toBe(1260);
    expect(pricing.percentageFinal(600, 33)).toBe(402); // discount floor((19800+50)/100) = 198
    expect(pricing.percentageFinal(600, 25)).toBe(450);
    expect(pricing.percentageFinal(1400, 33)).toBe(938); // discount floor((46200+50)/100) = 462
    expect(pricing.applyDiscount(fixed(200), 600)).toBe(200);
  });

  test('sanity: eligible, percent 1–90, 0 < final < base', () => {
    expect(pricing.isSaneForOption('monthly', pct(1))).toBe(true);
    expect(pricing.isSaneForOption('monthly', pct(90))).toBe(true);
    expect(pricing.isSaneForOption('monthly', pct(0))).toBe(false);
    expect(pricing.isSaneForOption('monthly', pct(91))).toBe(false);
    expect(pricing.isSaneForOption('monthly', fixed(599))).toBe(true);
    expect(pricing.isSaneForOption('monthly', fixed(600))).toBe(false);
    expect(pricing.isSaneForOption('monthly', fixed(0))).toBe(false);
    expect(pricing.isSaneForOption('six_months', pct(10))).toBe(false);
    expect(pricing.isSaneForOption('twelve_months', fixed(100))).toBe(false);
  });

  test('effective monthly and duration savings', () => {
    expect(pricing.effectiveMonthly(1400, 3)).toBe(467);
    expect(pricing.effectiveMonthly(4000, 12)).toBe(333);
    expect(pricing.durationSavings(4000, 12)).toBe(3200);
    expect(pricing.durationSavings(1260, 3)).toBe(540);
    expect(pricing.durationSavings(700, 1)).toBe(0);
  });

  test('no stacking: the lower final price wins; an exact tie goes to the offer', () => {
    const monthly = pricing.optionById('monthly');
    const offer = { _id: 'offer_1', title: 'عرض', discount: pct(10) }; // 540
    const coupon = { _id: 'coupon_1', code: 'TRY2', target: 'monthly', discount: fixed(200) };
    const better = pricing.buildQuote(monthly, { offer, coupon });
    expect(better.quote.finalPrice).toEqual({ amount: 200, currency: 'USD' });
    expect(better.quote.promotion).toEqual({ source: 'coupon', id: 'coupon_1', code: 'TRY2', label: 'TRY2' });
    expect(better.couponOutcome).toBe('applied');

    const tie = pricing.buildQuote(monthly, { offer: { ...offer, discount: fixed(400) }, coupon: { ...coupon, discount: fixed(400) } });
    expect(tie.quote.promotion.source).toBe('global_offer');
    expect(tie.couponOutcome).toBe('global_offer_is_better');

    const worse = pricing.buildQuote(monthly, { offer, coupon: { ...coupon, discount: pct(5) } });
    expect(worse.quote.finalPrice.amount).toBe(540);
    expect(worse.couponOutcome).toBe('global_offer_is_better');
    expect(worse.quote).toMatchObject({ promotionSavings: { amount: 60 }, durationSavings: { amount: 60 }, effectiveMonthly: { amount: 540 } });
  });
});

describe('public reads', () => {
  test('GET /pricing/catalog', async () => {
    const res = await f.api().get('/api/v1/pricing/catalog').expect(200);
    expect(res.body.currency).toBe('USD');
    expect(res.body.options).toEqual([
      { id: 'monthly', months: 1, basePrice: { amount: 600, currency: 'USD' }, effectiveMonthly: { amount: 600, currency: 'USD' }, promotionEligible: true, grantsFullAccess: true },
      { id: 'three_months', months: 3, basePrice: { amount: 1400, currency: 'USD' }, effectiveMonthly: { amount: 467, currency: 'USD' }, promotionEligible: true, grantsFullAccess: true },
      { id: 'six_months', months: 6, basePrice: { amount: 2400, currency: 'USD' }, effectiveMonthly: { amount: 400, currency: 'USD' }, promotionEligible: false, grantsFullAccess: true },
      { id: 'twelve_months', months: 12, basePrice: { amount: 4000, currency: 'USD' }, effectiveMonthly: { amount: 333, currency: 'USD' }, promotionEligible: false, grantsFullAccess: true },
    ]);
    expect(res.body.support).toHaveProperty('email');
  });

  test('GET /pricing/offers/active and /pricing/quotes reflect live offers only', async () => {
    const empty = await f.api().get('/api/v1/pricing/offers/active').expect(200);
    expect(empty.body).toEqual([]);

    const live = await createOffer({ target: 'three_months', discount: pct(10), title: 'عرض الخريف', enabled: true }).expect(201);
    await createOffer({ target: 'monthly', discount: pct(50), enabled: false }).expect(201);
    await f.models.GlobalOffer.create({ target: 'monthly', discount: pct(20), enabled: true, endsAt: new Date(Date.now() - 1000) });

    const offers = await f.api().get('/api/v1/pricing/offers/active').expect(200);
    expect(offers.body).toEqual([{ id: live.body.id, target: 'three_months', discount: { kind: 'percentage', percent: 10 }, title: 'عرض الخريف', endsAt: null }]);

    const quotes = await f.api().get('/api/v1/pricing/quotes').expect(200);
    expect(quotes.body).toHaveLength(4);
    const [monthly, three, , twelve] = quotes.body;
    expect(monthly).toMatchObject({ billingOptionId: 'monthly', finalPrice: { amount: 600 } });
    expect(monthly).not.toHaveProperty('promotion');
    expect(three).toMatchObject({
      billingOptionId: 'three_months',
      months: 3,
      basePrice: { amount: 1400, currency: 'USD' },
      finalPrice: { amount: 1260, currency: 'USD' },
      promotion: { source: 'global_offer', id: live.body.id, label: 'عرض الخريف' },
      promotionSavings: { amount: 140, currency: 'USD' },
      durationSavings: { amount: 540, currency: 'USD' },
      effectiveMonthly: { amount: 420, currency: 'USD' },
    });
    expect(twelve).toMatchObject({ finalPrice: { amount: 4000 }, durationSavings: { amount: 3200 } });

    // Bearer optional; an authenticated caller sees the same thing.
    await f.api().get('/api/v1/pricing/quotes').set(f.auth(main.token)).expect(200);
    await f.api().post(`${P}/offers/${live.body.id}/disable`).set(f.auth(platform.token)).expect(200);
  });
});

describe('POST /pricing/quote', () => {
  let offer;
  beforeAll(async () => {
    offer = (await createOffer({ target: 'monthly', discount: fixed(400), title: 'شهر بـ 4', enabled: true }).expect(201)).body;
  });
  afterAll(async () => {
    await f.api().delete(`${P}/offers/${offer.id}`).set(f.auth(platform.token)).expect(204);
  });

  test('requires a session', async () => {
    const res = await f.api().post('/api/v1/pricing/quote').send({ billingOptionId: 'monthly' }).expect(401);
    expect(res.body.error.code).toBe('authentication_expired');
  });

  test('validation: unknown option', async () => {
    const res = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'weekly' }).expect(422);
    expect(res.body.error.fields).toHaveProperty('billingOptionId');
  });

  test('offer only / better coupon / tie / invalid coupon / coupon for another option', async () => {
    const base = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'monthly' }).expect(200);
    expect(base.body).toMatchObject({ finalPrice: { amount: 400 }, promotion: { source: 'global_offer', id: offer.id } });
    expect(base.body).not.toHaveProperty('couponOutcome');

    const better = (await createCoupon({ code: code(), target: 'monthly', discount: fixed(200), enabled: true }).expect(201)).body;
    const r1 = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'monthly', couponCode: better.code.toLowerCase() }).expect(200);
    expect(r1.body).toMatchObject({ finalPrice: { amount: 200 }, promotion: { source: 'coupon', code: better.code, label: better.code }, couponOutcome: 'applied' });

    const tie = (await createCoupon({ code: code(), target: 'monthly', discount: fixed(400), enabled: true }).expect(201)).body;
    const r2 = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'monthly', couponCode: tie.code }).expect(200);
    expect(r2.body).toMatchObject({ finalPrice: { amount: 400 }, promotion: { source: 'global_offer' }, couponOutcome: 'global_offer_is_better' });

    const r3 = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'monthly', couponCode: 'NOPE-NOPE' }).expect(200);
    expect(r3.body).toMatchObject({ finalPrice: { amount: 400 }, couponOutcome: 'invalid', couponError: 'coupon_not_found' });

    const three = (await createCoupon({ code: code(), target: 'three_months', discount: pct(10), enabled: true }).expect(201)).body;
    const r4 = await f.api().post('/api/v1/pricing/quote').set(f.auth(main.token)).send({ billingOptionId: 'monthly', couponCode: three.code }).expect(200);
    expect(r4.body).toMatchObject({ couponOutcome: 'invalid', couponError: 'coupon_not_eligible', couponTarget: 'three_months' });
  });
});

describe('POST /pricing/coupons/validate — a READ, never a redemption', () => {
  test('success shape; note never leaks; appliesToSelected', async () => {
    const c = (await createCoupon({ code: code(), target: 'three_months', discount: pct(10), note: 'حملة داخلية', enabled: true }).expect(201)).body;
    const res = await validate(main.token, { code: ` ${c.code.toLowerCase()} `, billingOptionId: 'monthly' }).expect(200);
    expect(res.body).toMatchObject({
      valid: true,
      coupon: { code: c.code, target: 'three_months' },
      quote: { billingOptionId: 'three_months', finalPrice: { amount: 1260 }, promotion: { source: 'coupon', code: c.code } },
      couponOutcome: 'applied',
      appliesToSelected: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('حملة داخلية');
    const same = await validate(main.token, { code: c.code, billingOptionId: 'three_months' }).expect(200);
    expect(same.body.appliesToSelected).toBe(true);
    const noOption = await validate(main.token, { code: c.code }).expect(200);
    expect(noOption.body.appliesToSelected).toBe(true);
  });

  test('validating 5× never changes usedCount', async () => {
    const c = (await createCoupon({ code: code(), target: 'monthly', discount: fixed(200), maxUses: 1, enabled: true }).expect(201)).body;
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await validate(main.token, { code: c.code }).expect(200);
    }
    const doc = await f.models.Coupon.findById(c.id);
    expect(doc.usedCount).toBe(0);
    expect(await f.models.CouponRedemption.countDocuments({ couponId: c.id })).toBe(0);
    expect(await f.models.AuditEvent.countDocuments({ action: 'commerce_coupon_redeemed' })).toBe(0);
  });

  test('refusal codes in the contract order', async () => {
    const other = await f.createAccount({ role: 'main_admin' });
    const mk = (overrides) => f.models.Coupon.create({ code: code(), target: 'monthly', discount: fixed(200), enabled: true, ...overrides });
    const expectCode = async (body, expected) => {
      const res = await validate(main.token, body).expect(422);
      expect(res.body.error.code).toBe(expected);
    };
    await expectCode({ code: 'UNKNOWN-1' }, 'coupon_not_found');
    await expectCode({ code: '!!' }, 'coupon_not_found');
    await expectCode({ code: '' }, 'coupon_not_found');
    await expectCode({ code: (await mk({ enabled: false })).code }, 'coupon_disabled');
    // disabled outranks expired
    await expectCode({ code: (await mk({ enabled: false, expiresAt: new Date(Date.now() - 1000) })).code }, 'coupon_disabled');
    await expectCode({ code: (await mk({ expiresAt: new Date(Date.now() - 1000) })).code }, 'coupon_expired');
    await expectCode({ code: (await mk({ assignment: { kind: 'account', accountId: String(other._id) } })).code }, 'coupon_not_assigned');
    await expectCode({ code: (await mk({ target: 'six_months', discount: pct(10) })).code }, 'coupon_not_eligible');
    await expectCode({ code: (await mk({ maxUses: 2, usedCount: 2 })).code }, 'coupon_exhausted');
    await expectCode({ code: (await mk({ discount: fixed(700) })).code }, 'coupon_invalid_price');

    const mine = await mk({ assignment: { kind: 'account', accountId: String(main.account._id) } });
    await validate(main.token, { code: mine.code }).expect(200);
    const missing = await validate(main.token, {}).expect(422);
    expect(missing.body.error.code).toBe('validation');
  });

  test('any full session may validate — including a Customer Demo', async () => {
    const c = (await createCoupon({ code: code(), target: 'monthly', discount: pct(25), enabled: true }).expect(201)).body;
    const demo = await f.api().post('/api/v1/auth/customer-demo/start').send({}).expect(201);
    const res = await validate(demo.body.accessToken, { code: c.code }).expect(200);
    expect(res.body.quote.finalPrice.amount).toBe(450);
    await validate(simple.token, { code: c.code }).expect(200);
    await f.api().post('/api/v1/pricing/coupons/validate').send({ code: c.code }).expect(401);
  });
});

describe('platform offers', () => {
  test('authorization: platform only', async () => {
    for (const token of [main.token, simple.token]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await f.api().get(`${P}/offers`).set(f.auth(token)).expect(403);
      expect(res.body.error.code).toBe('not_permitted');
    }
  });

  test('create: validation, promotion_invalid, key required', async () => {
    const unknown = await createOffer({ target: 'weekly', discount: pct(10) }).expect(422);
    expect(unknown.body.error.code).toBe('validation');
    const noDiscount = await createOffer({ target: 'monthly' }).expect(422);
    expect(noDiscount.body.error.fields).toHaveProperty('discount');
    for (const [target, discount] of [
      ['six_months', pct(10)],
      ['monthly', pct(95)],
      ['monthly', pct(0)],
      ['monthly', fixed(600)],
      ['monthly', fixed(0)],
      ['three_months', fixed(1500)],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createOffer({ target, discount }).expect(422);
      expect(res.body.error.code).toBe('promotion_invalid');
    }
    await f.api().post(`${P}/offers`).set(f.auth(platform.token)).send({ target: 'monthly', discount: pct(10) }).expect(422);
  });

  test('lifecycle: create → conflict → patch → enable/disable → delete (+ audit)', async () => {
    const a = await createOffer({ target: 'three_months', discount: pct(15), title: '  عرض   أ ', enabled: true }).expect(201);
    expect(a.body).toMatchObject({ enabled: true, live: true, target: 'three_months', discount: { kind: 'percentage', percent: 15 }, title: 'عرض أ', endsAt: null });
    expect(a.body.id).toMatch(/^offer_/);

    const conflict = await createOffer({ target: 'three_months', discount: pct(20), enabled: true }).expect(409);
    expect(conflict.body.error.code).toBe('offer_conflict');
    const b = await createOffer({ target: 'three_months', discount: pct(20) }).expect(201);
    expect(b.body.live).toBe(false);
    const enableConflict = await f.api().post(`${P}/offers/${b.body.id}/enable`).set(f.auth(platform.token)).set(f.idem()).expect(409);
    expect(enableConflict.body.error.code).toBe('offer_conflict');

    // A live offer that already ENDED does not conflict.
    const endsAt = new Date(Date.now() + 86400000).toISOString();
    const patched = await f.api().patch(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).send({ discount: fixed(1000), endsAt }).expect(200);
    expect(patched.body).toMatchObject({ discount: { kind: 'fixed_final_price', finalPrice: { amount: 1000, currency: 'USD' } }, endsAt });
    const badPatch = await f.api().patch(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).send({ target: 'twelve_months' }).expect(422);
    expect(badPatch.body.error.code).toBe('promotion_invalid');
    await f.api().patch(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).send({}).expect(422);
    await f.api().patch(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).send({ endsAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
    const enabled = await f.api().post(`${P}/offers/${b.body.id}/enable`).set(f.auth(platform.token)).expect(200);
    expect(enabled.body).toMatchObject({ enabled: true, live: true });

    const disabled = await f.api().post(`${P}/offers/${b.body.id}/disable`).set(f.auth(platform.token)).expect(200);
    expect(disabled.body.enabled).toBe(false);

    const list = await f.api().get(`${P}/offers`).set(f.auth(platform.token)).expect(200);
    expect(list.body.map((o) => o.id)).toEqual(expect.arrayContaining([a.body.id, b.body.id]));

    await f.api().delete(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).expect(204);
    const gone = await f.api().delete(`${P}/offers/${a.body.id}`).set(f.auth(platform.token)).expect(404);
    expect(gone.body.error.code).toBe('offer_not_found');
    const missing = await f.api().post(`${P}/offers/offer_nope/enable`).set(f.auth(platform.token)).expect(404);
    expect(missing.body.error.code).toBe('offer_not_found');

    const actions = (await f.models.AuditEvent.find({ 'target.id': { $in: [a.body.id, b.body.id] } })).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['commerce_offer_created', 'commerce_offer_updated', 'commerce_offer_enabled', 'commerce_offer_disabled', 'commerce_offer_removed']),
    );
    await f.api().delete(`${P}/offers/${b.body.id}`).set(f.auth(platform.token)).expect(204);
  });
});

describe('platform coupons', () => {
  test('create: normalization, invalid code, taken code, promotion_invalid', async () => {
    const raw = `  lead er-${f.uniq()}  `.slice(0, 20);
    const c = await createCoupon({ code: raw, target: 'monthly', discount: pct(10), note: 'ملاحظة داخلية', maxUses: 3 }).expect(201);
    const normalized = raw.trim().replace(/\s+/g, '').toUpperCase();
    expect(c.body).toMatchObject({
      code: normalized,
      enabled: false,
      live: false,
      target: 'monthly',
      assignment: { kind: 'public' },
      note: 'ملاحظة داخلية',
      maxUses: 3,
      usedCount: 0,
      expiresAt: null,
    });
    const taken = await createCoupon({ code: normalized.toLowerCase(), target: 'monthly', discount: pct(10) }).expect(409);
    expect(taken.body.error.code).toBe('coupon_code_taken');
    for (const bad of ['ab', 'كود-عربي', 'X'.repeat(25), 'HAS_UNDERSCORE']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createCoupon({ code: bad, target: 'monthly', discount: pct(10) }).expect(422);
      expect(res.body.error.code).toBe('coupon_code_invalid');
    }
    const invalid = await createCoupon({ code: code(), target: 'six_months', discount: pct(10) }).expect(422);
    expect(invalid.body.error.code).toBe('promotion_invalid');
    const zero = await createCoupon({ code: code(), target: 'monthly', discount: pct(10), maxUses: 0 }).expect(422);
    expect(zero.body.error.fields).toHaveProperty('maxUses');
  });

  test('targeted by email: resolved server-side, only the id stored', async () => {
    const c = await createCoupon({
      code: code(),
      target: 'monthly',
      discount: fixed(200),
      assignment: { kind: 'account', email: `  ${main.account.email.toUpperCase()} ` },
      enabled: true,
    }).expect(201);
    expect(c.body.assignment).toEqual({ kind: 'account', accountId: String(main.account._id), accountEmail: main.account.email });
    const stored = await f.models.Coupon.findById(c.body.id).lean();
    expect(stored.assignment).toEqual({ kind: 'account', accountId: String(main.account._id) });

    const byId = await createCoupon({ code: code(), target: 'monthly', discount: fixed(200), assignment: { kind: 'account', accountId: String(simple.account._id) } }).expect(201);
    expect(byId.body.assignment.accountId).toBe(String(simple.account._id));

    for (const assignment of [{ kind: 'account', email: 'nobody@nowhere.test' }, { kind: 'account', accountId: 'u_nope' }, { kind: 'account' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createCoupon({ code: code(), target: 'monthly', discount: fixed(200), assignment }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'validation' });
      expect(res.body.error.fields).toHaveProperty('assignment');
    }
  });

  test('patch, enable/disable, delete, not_found (+ audit)', async () => {
    const c = (await createCoupon({ code: code(), target: 'monthly', discount: pct(10) }).expect(201)).body;
    const other = (await createCoupon({ code: code(), target: 'monthly', discount: pct(10) }).expect(201)).body;
    const patched = await f.api().patch(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).send({ target: 'three_months', discount: pct(20), maxUses: null, note: '' }).expect(200);
    expect(patched.body).toMatchObject({ target: 'three_months', discount: { percent: 20 }, maxUses: null, note: null });
    const taken = await f.api().patch(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).send({ code: other.code }).expect(409);
    expect(taken.body.error.code).toBe('coupon_code_taken');
    const badCode = await f.api().patch(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).send({ code: '?' }).expect(422);
    expect(badCode.body.error.code).toBe('coupon_code_invalid');
    const badPrice = await f.api().patch(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).send({ discount: fixed(1400) }).expect(422);
    expect(badPrice.body.error.code).toBe('promotion_invalid');

    const on = await f.api().post(`${P}/coupons/${c.id}/enable`).set(f.auth(platform.token)).expect(200);
    expect(on.body).toMatchObject({ enabled: true, live: true });
    const off = await f.api().post(`${P}/coupons/${c.id}/disable`).set(f.auth(platform.token)).expect(200);
    expect(off.body.enabled).toBe(false);

    const list = await f.api().get(`${P}/coupons`).set(f.auth(platform.token)).expect(200);
    expect(list.body.find((x) => x.id === c.id)).toBeDefined();
    await f.api().get(`${P}/coupons`).set(f.auth(main.token)).expect(403);

    await f.api().delete(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).expect(204);
    const gone = await f.api().patch(`${P}/coupons/${c.id}`).set(f.auth(platform.token)).send({ enabled: true }).expect(404);
    expect(gone.body.error.code).toBe('coupon_not_found');

    const actions = (await f.models.AuditEvent.find({ 'target.id': c.id })).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['commerce_coupon_created', 'commerce_coupon_updated', 'commerce_coupon_enabled', 'commerce_coupon_disabled', 'commerce_coupon_removed']),
    );
  });
});
