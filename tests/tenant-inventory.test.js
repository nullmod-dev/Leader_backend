/**
 * Inventory items + the append-only movement ledger: packaging rules,
 * insufficient_stock, race safety, feature gate, capabilities, images.
 */
const sharp = require('sharp');
const f = require('./helpers/factory');

const { InventoryItem, InventoryMovement, ChangeLog, StoredFile } = f.models;

let tenant;
let main;
let det;
let png;
const A = () => f.auth(main.token);

const setFeature = (t, key, enabled) => f.models.SaasTenant.updateOne({ _id: t._id, 'features.key': key }, { $set: { 'features.$.enabled': enabled } });

const createItem = (body) =>
  f.api()
    .post('/api/v1/inventory-items')
    .set(A())
    .send({ detachmentId: String(det._id), name: 'شاش معقم', unit: 'علبة', ...body });

beforeAll(async () => {
  ({ tenant, main } = await f.tenantWithMainAdmin());
  det = await f.detachment(tenant);
  png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#555' } }).png().toBuffer();
});

describe('POST /inventory-items', () => {
  test('opening stock in cartons → base units + an opening inflow movement', async () => {
    const res = await createItem({ openingStock: 2, openingUnit: 'carton', unitsPerStrip: 10, stripsPerCarton: 5, minimum: 30, expiresOn: '2027-01-31' }).expect(201);
    expect(res.body).toMatchObject({
      name: 'شاش معقم',
      unit: 'علبة',
      currentStock: 100,
      minimum: 30,
      level: 'ok',
      unitsPerStrip: 10,
      stripsPerCarton: 5,
      preferredUnit: 'carton',
      expiresOn: '2027-01-31',
      version: 1,
    });
    const mv = await InventoryMovement.find({ itemId: res.body.id });
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({
      direction: 'inflow',
      quantity: 2,
      packagingUnit: 'carton',
      convertedBaseUnitQuantity: 100,
      source: 'inventory_setup',
      reason: 'رصيد افتتاحي',
      stockBefore: 0,
      stockAfter: 100,
      performedBy: String(main.account._id),
    });
  });

  test('zero opening stock → no movement, level empty', async () => {
    const res = await createItem({ name: 'قفازات' }).expect(201);
    expect(res.body).toMatchObject({ currentStock: 0, level: 'empty', preferredUnit: 'individual' });
    expect(await InventoryMovement.countDocuments({ itemId: res.body.id })).toBe(0);
  });

  test('validation: blank name/unit, negatives, packaging ≤ 0, bad day → 422', async () => {
    for (const body of [{ name: ' ' }, { unit: '' }, { openingStock: -1 }, { minimum: -2 }, { unitsPerStrip: 0 }, { stripsPerCarton: -1 }, { expiresOn: '31/01/2027' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createItem(body).expect(422);
      expect(res.body.error.code).toBe('validation');
    }
  });

  test('strip/carton opening without packaging → 422 packaging_required', async () => {
    const strip = await createItem({ openingStock: 3, openingUnit: 'strip' }).expect(422);
    expect(strip.body.error.code).toBe('packaging_required');
    const carton = await createItem({ openingStock: 3, openingUnit: 'carton', unitsPerStrip: 10 }).expect(422);
    expect(carton.body.error.code).toBe('packaging_required');
  });

  test('unknown detachment → 404; without inventory.item.manage → 403', async () => {
    await f.api().post('/api/v1/inventory-items').set(A()).send({ detachmentId: 'd_missing', name: 'x', unit: 'y' }).expect(404);
    const adjuster = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['inventory.adjust'] } });
    const res = await f.api().post('/api/v1/inventory-items').set(f.auth(adjuster.token)).send({ detachmentId: String(det._id), name: 'x', unit: 'y' }).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
  });
});

describe('movements', () => {
  test('inflow in cartons, outflow in strips; lastMovement; performedBy from the session', async () => {
    const created = await createItem({ openingStock: 5, unitsPerStrip: 10, stripsPerCarton: 2, minimum: 20 }).expect(201);
    const id = created.body.id;
    const inflow = await f.api()
      .post(`/api/v1/inventory-items/${id}/movements`)
      .set(A())
      .set(f.idem())
      .send({ itemId: id, direction: 'inflow', quantity: 1, packagingUnit: 'carton', reason: 'توريد', performedBy: 'u_spoof', performedByName: 'مزيف' })
      .expect(200);
    expect(inflow.body).toMatchObject({ id, currentStock: 25, level: 'ok', version: 2 });
    expect(inflow.body.lastMovement).toMatchObject({
      itemId: id,
      direction: 'inflow',
      quantity: 1,
      packagingUnit: 'carton',
      convertedBaseUnitQuantity: 20,
      stockBefore: 5,
      stockAfter: 25,
      reason: 'توريد',
      source: 'mobile_app',
      performedBy: String(main.account._id),
      performedByName: main.account.name,
    });

    const outflow = await f.api().post(`/api/v1/inventory-items/${id}/movements`).set(A()).send({ direction: 'outflow', quantity: 1, packagingUnit: 'strip', reason: 'مناوبة' }).expect(200);
    expect(outflow.body).toMatchObject({ currentStock: 15, level: 'low', version: 3 });
    expect(outflow.body.lastMovement).toMatchObject({ stockBefore: 25, stockAfter: 15, convertedBaseUnitQuantity: 10 });

    const list = await f.api().get(`/api/v1/inventory-items/${id}/movements`).set(A()).expect(200);
    expect(list.body.map((m) => m.direction)).toEqual(['outflow', 'inflow', 'inflow']);
    const one = await f.api().get(`/api/v1/inventory-items/${id}/movements`).query({ limit: 1 }).set(A()).expect(200);
    expect(one.body).toHaveLength(1);

    // the atomic update is visible to sync
    const logged = await ChangeLog.find({ entityType: 'inventory_item', entityId: id }).sort({ seq: 1 });
    expect(logged.map((l) => l.version)).toEqual([1, 2, 3]);
  });

  test('outflow larger than stock → 409 insufficient_stock; nothing recorded', async () => {
    const created = await createItem({ openingStock: 3 }).expect(201);
    const res = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ direction: 'outflow', quantity: 4, reason: 'x' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'insufficient_stock', currentStock: 3, requested: 4 });
    expect(await InventoryMovement.countDocuments({ itemId: created.body.id })).toBe(1);
    expect((await InventoryItem.findById(created.body.id)).currentStock).toBe(3);
  });

  test('outflow to exactly zero → level empty', async () => {
    const created = await createItem({ openingStock: 2, minimum: 1 }).expect(201);
    const res = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ direction: 'outflow', quantity: 2, reason: 'نفد' }).expect(200);
    expect(res.body).toMatchObject({ currentStock: 0, level: 'empty' });
  });

  test('packaging not supported → 422 packaging_unavailable; bad quantity → 422', async () => {
    const created = await createItem({ openingStock: 3 }).expect(201);
    const res = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ direction: 'inflow', quantity: 1, packagingUnit: 'strip', reason: 'x' }).expect(422);
    expect(res.body.error.code).toBe('packaging_unavailable');
    for (const quantity of [0, -3, 1.5, 'many']) {
      // eslint-disable-next-line no-await-in-loop
      await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ direction: 'inflow', quantity, reason: 'x' }).expect(422);
    }
    await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ direction: 'sideways', quantity: 1 }).expect(422);
    await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).send({ itemId: 'i_other', direction: 'inflow', quantity: 1 }).expect(422);
  });

  test('concurrent outflows never drive stock negative', async () => {
    const created = await createItem({ openingStock: 5 }).expect(201);
    const id = created.body.id;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.api().post(`/api/v1/inventory-items/${id}/movements`).set(A()).send({ direction: 'outflow', quantity: 1, reason: 'سباق' })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 409 && r.body.error.code === 'insufficient_stock').length;
    expect(ok).toBe(5);
    expect(refused).toBe(3);
    const item = await InventoryItem.findById(id);
    expect(item.currentStock).toBe(0);
    expect(item.level).toBe('empty');
    expect(await InventoryMovement.countDocuments({ itemId: id, direction: 'outflow' })).toBe(5);
  });

  test('idempotent movement replays without a second effect', async () => {
    const created = await createItem({ openingStock: 5 }).expect(201);
    const key = f.idem();
    const body = { direction: 'outflow', quantity: 2, reason: 'مرة واحدة' };
    const a = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).set(key).send(body).expect(200);
    const b = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(A()).set(key).send(body).expect(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.lastMovement.id).toBe(a.body.lastMovement.id);
    expect((await InventoryItem.findById(created.body.id)).currentStock).toBe(3);
  });

  test('capabilities: inventory.adjust to move; detachment.view to read', async () => {
    const created = await createItem({ openingStock: 5 }).expect(201);
    const manager = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['inventory.item.manage'] } });
    const res = await f.api().post(`/api/v1/inventory-items/${created.body.id}/movements`).set(f.auth(manager.token)).send({ direction: 'inflow', quantity: 1 }).expect(403);
    expect(res.body.error.code).toBe('not_permitted');
    const stranger = await f.simpleAdmin(tenant, { global: [], scoped: { d_elsewhere: ['inventory.adjust'] } });
    await f.api().get(`/api/v1/inventory-items/${created.body.id}`).set(f.auth(stranger.token)).expect(403);
    await f.api().get(`/api/v1/inventory-items/${created.body.id}/movements`).set(f.auth(stranger.token)).expect(403);
    await f.api().get(`/api/v1/inventory-items/${created.body.id}`).set(f.auth(manager.token)).expect(200);
  });
});

describe('item edit / delete / image', () => {
  test('PUT edits everything but the quantity; level recomputed; expiresOn null clears', async () => {
    const created = await createItem({ openingStock: 10, minimum: 2, expiresOn: '2027-03-01' }).expect(201);
    const id = created.body.id;
    const res = await f.api()
      .put(`/api/v1/inventory-items/${id}`)
      .set(A())
      .send({ id, name: 'شاش طبي', unit: 'لفة', minimum: 20, currentStock: 999, expiresOn: null, unitsPerStrip: 4, stripsPerCarton: 3, preferredUnit: 'strip' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'شاش طبي', unit: 'لفة', minimum: 20, currentStock: 10, level: 'low', unitsPerStrip: 4, stripsPerCarton: 3, preferredUnit: 'strip', version: 2 });
    expect(res.body.expiresOn).toBeUndefined();

    const patch = await f.api().patch(`/api/v1/inventory-items/${id}`).set(A()).send({ expiresOn: '2027-04-01' }).expect(200);
    expect(patch.body).toMatchObject({ expiresOn: '2027-04-01', name: 'شاش طبي' });

    const bad = await f.api().patch(`/api/v1/inventory-items/${id}`).set(A()).send({ unitsPerStrip: 1, preferredUnit: 'strip' }).expect(422);
    expect(bad.body.error.code).toBe('packaging_required');
    await f.api().put(`/api/v1/inventory-items/${id}`).set(A()).send({ name: 'x', unit: 'y' }).expect(422); // minimum required

    const stale = await f.api().patch(`/api/v1/inventory-items/${id}`).set(A()).send({ minimum: 1, version: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_write', currentVersion: 3 });
  });

  test('DELETE removes the item, its movements and its image', async () => {
    const created = await createItem({ openingStock: 4 }).expect(201);
    const id = created.body.id;
    const up = await f.api().post(`/api/v1/inventory-items/${id}/image`).set(A()).attach('image', png, 'i.png').expect(200);
    expect(up.body.imageUrl).toMatch(/\/images\/inventory\/inventory_item-.*\.webp$/);
    const adjuster = await f.simpleAdmin(tenant, { global: [], scoped: { [det._id]: ['inventory.adjust'] } });
    await f.api().delete(`/api/v1/inventory-items/${id}`).set(f.auth(adjuster.token)).expect(403);
    await f.api().delete(`/api/v1/inventory-items/${id}`).set(A()).expect(204);
    expect(await InventoryItem.countDocuments({ _id: id })).toBe(0);
    expect(await InventoryMovement.countDocuments({ itemId: id })).toBe(0);
    expect(await StoredFile.countDocuments({ ownerType: 'inventory_item', ownerId: id })).toBe(0);
    await f.api().get(`/api/v1/inventory-items/${id}`).set(A()).expect(404);
  });

  test('image delete clears imageUrl', async () => {
    const created = await createItem({}).expect(201);
    await f.api().post(`/api/v1/inventory-items/${created.body.id}/image`).set(A()).attach('image', png, 'i.png').expect(200);
    const res = await f.api().delete(`/api/v1/inventory-items/${created.body.id}/image`).set(A()).expect(200);
    expect(res.body.imageUrl).toBeUndefined();
  });

  test('an item of another tenant → 404', async () => {
    const { tenant: other } = await f.tenantWithMainAdmin();
    const foreign = await f.inventoryItem(other, await f.detachment(other));
    const res = await f.api().get(`/api/v1/inventory-items/${foreign._id}`).set(A()).expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('feature gate', () => {
  test('inventory disabled → 403 feature_disabled on every route', async () => {
    const { tenant: t2, main: m2 } = await f.tenantWithMainAdmin();
    const d2 = await f.detachment(t2);
    const item = await f.inventoryItem(t2, d2);
    await setFeature(t2, 'inventory', false);
    const auth = f.auth(m2.token);
    for (const [method, url, body] of [
      ['get', `/api/v1/inventory-items/${item._id}`],
      ['post', '/api/v1/inventory-items', { detachmentId: String(d2._id), name: 'x', unit: 'y' }],
      ['post', `/api/v1/inventory-items/${item._id}/movements`, { direction: 'inflow', quantity: 1 }],
      ['get', `/api/v1/inventory-items/${item._id}/movements`],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await f.api()[method](url).set(auth).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    }
  });
});
