/**
 * POST /sync/push + GET /sync/status.
 *
 * Push replays each operation over LOOPBACK HTTP, so the app must listen on a
 * real port (`req.socket.localPort`). Tests only depend on endpoints this
 * module owns: test kinds are registered against PUT /settings/notifications
 * and PATCH /settings/organization. The response → result mapping (stale_write,
 * in-progress, 5xx, feature_disabled …) is unit-tested with fake responses.
 */
const request = require('supertest');
const f = require('./helpers/factory');
const app = require('../app');
const syncService = require('../services/syncService');
const { uuidV7 } = require('../utils/ids');

let server;
const push = (token, operations, headers = {}) =>
  request(server).post('/api/v1/sync/push').set(f.auth(token)).set(headers).send({ operations });

const prefs = (overrides = {}) => ({ shiftReminders: false, stockAlerts: true, workshopUpdates: false, joinRequests: true, ...overrides });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  syncService.registerKind('test.notifications.put', { method: 'PUT', path: '/settings/notifications' });
  syncService.registerKind('test.organization.patch', { method: 'PATCH', path: '/settings/organization' });
});

afterAll(async () => {
  syncService.unregisterKind('test.notifications.put');
  syncService.unregisterKind('test.organization.patch');
  await new Promise((resolve) => server.close(resolve));
});

describe('POST /sync/push — loopback dispatch', () => {
  test('applied, then duplicate when the same operationId is replayed', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const op = { operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs() };
    const res = await push(main.token, [op]).expect(200);
    expect(res.body.serverTime).toEqual(expect.any(String));
    expect(res.body.results).toEqual([
      { operationId: op.operationId, kind: op.kind, status: 'applied', httpStatus: 200, terminal: true, entity: prefs() },
    ]);
    const fresh = await f.models.Account.findById(main.account._id);
    expect(fresh.notificationPrefs.joinRequests).toBe(true);

    const again = await push(main.token, [op]).expect(200);
    expect(again.body.results[0]).toMatchObject({ status: 'duplicate', httpStatus: 200, terminal: true, entity: prefs() });

    // Same identity twice in ONE batch: the second is a duplicate of the first.
    const op2 = { operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs({ stockAlerts: false }) };
    const both = await push(main.token, [op2, op2]).expect(200);
    expect(both.body.results.map((r) => r.status)).toEqual(['applied', 'duplicate']);
  });

  test('the endpoint validates: bad payload → rejected validation (terminal, fields)', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const res = await push(main.token, [{ operationId: uuidV7(), kind: 'test.notifications.put', payload: { shiftReminders: 'yes' } }]).expect(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', httpStatus: 422, code: 'validation', terminal: true });
    expect(res.body.results[0].fields).toHaveProperty('shiftReminders');
  });

  test('same operationId with a different body → rejected idempotency_conflict', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const operationId = uuidV7();
    await push(main.token, [{ operationId, kind: 'test.notifications.put', payload: prefs() }]).expect(200);
    const res = await push(main.token, [{ operationId, kind: 'test.notifications.put', payload: prefs({ shiftReminders: true }) }]).expect(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', httpStatus: 409, code: 'idempotency_conflict', terminal: true });
  });

  test('a replayed write is re-authorized: no org.edit → rejected not_permitted', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const simple = await f.simpleAdmin(tenant);
    const op = { operationId: uuidV7(), kind: 'test.organization.patch', payload: { address: 'حمص' } };
    const res = await push(simple.token, [op]).expect(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', httpStatus: 403, code: 'not_permitted', terminal: true });

    // The Main Admin may; the batch runs sequentially in order (last write wins).
    const ok = await push(main.token, [
      { operationId: uuidV7(), kind: 'test.organization.patch', payload: { address: 'حمص' } },
      { operationId: uuidV7(), kind: 'test.organization.patch', payload: { address: 'حماة' } },
    ]).expect(200);
    expect(ok.body.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect((await f.models.SaasTenant.findById(tenant._id)).org.address).toBe('حماة');
  });

  test('unknown kind → rejected unsupported_operation; missing path id → rejected validation; others still run', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const unknown = { operationId: uuidV7(), kind: 'made.up', payload: {} };
    const noItem = { operationId: uuidV7(), kind: 'inventory.movement.add', payload: { direction: 'inflow', quantity: 1 } };
    const good = { operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs() };
    const res = await push(main.token, [unknown, noItem, good]).expect(200);
    expect(res.body.results[0]).toMatchObject({ operationId: unknown.operationId, status: 'rejected', code: 'unsupported_operation', terminal: true });
    expect(res.body.results[1]).toMatchObject({ status: 'rejected', code: 'validation', terminal: true, fields: { 'payload.itemId': expect.any(String) } });
    expect(res.body.results[2].status).toBe('applied');
    // Nothing was recorded for the refused-before-dispatch operations.
    expect(await f.models.IdempotencyRecord.countDocuments({ _id: new RegExp(unknown.operationId) })).toBe(0);
  });

  test('batch Idempotency-Key replays the whole result set', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const ops = [{ operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs() }];
    const key = { 'Idempotency-Key': uuidV7() };
    const a = await push(main.token, ops, key).expect(200);
    const b = await push(main.token, ops, key).expect(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
  });

  test('batch validation and authorization', async () => {
    const { main } = await f.tenantWithMainAdmin();
    const empty = await push(main.token, []).expect(422);
    expect(empty.body.error.code).toBe('validation');
    const many = Array.from({ length: 51 }, () => ({ operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs() }));
    await push(main.token, many).expect(422);
    const bad = await push(main.token, [{ operationId: 'short', kind: 'x', payload: {} }]).expect(422);
    expect(Object.keys(bad.body.error.fields)).toContain('operations[0].operationId');
    await push(main.token, [{ operationId: uuidV7(), payload: {} }]).expect(422);
    await push(main.token, [{ operationId: uuidV7(), kind: 'x', payload: {}, version: 0 }]).expect(422);

    await request(server).post('/api/v1/sync/push').send({ operations: [] }).expect(401);
    const platform = await f.superAdmin();
    const refused = await push(platform.token, [{ operationId: uuidV7(), kind: 'test.notifications.put', payload: prefs() }]).expect(403);
    expect(refused.body.error.code).toBe('tenant_context_unavailable');
  });
});

describe('operation → request mapping', () => {
  test('the catalogue holds every contracted kind', () => {
    expect(Object.keys(syncService.CATALOGUE)).toEqual(
      expect.arrayContaining([
        'inventory.movement.add',
        'shift.attendance.checkIn',
        'shift.attendance.checkOut',
        'shift.attendance.absent',
        'shift.attendance.reset',
        'shift.attendance.mark',
        'shift.attendance.correct',
        'shift.assign',
        'shift.unassign',
        'shift.update',
        'member.update',
        'workshop.participant.attendance',
        'workshop.participant.payment',
      ]),
    );
  });

  test('path params come out of the payload; the rest is the body; version is merged', () => {
    expect(
      syncService.buildOperationRequest({
        kind: 'inventory.movement.add',
        payload: { itemId: 'i1', direction: 'inflow', quantity: 2, reason: 'مزامنة', packagingUnit: 'strip' },
      }),
    ).toEqual({ method: 'POST', path: '/inventory-items/i1/movements', body: { direction: 'inflow', quantity: 2, reason: 'مزامنة', packagingUnit: 'strip' } });
    expect(syncService.buildOperationRequest({ kind: 'member.update', payload: { memberId: 'm1', name: 'x' }, version: 4 })).toEqual({
      method: 'PATCH',
      path: '/members/m1',
      body: { name: 'x', version: 4 },
    });
    expect(syncService.buildOperationRequest({ kind: 'shift.unassign', payload: { shiftId: 'sh 1', memberId: 'm/2' } })).toEqual({
      method: 'DELETE',
      path: '/shifts/sh%201/assignments/m%2F2',
      body: undefined,
    });
    expect(syncService.buildOperationRequest({ kind: 'shift.attendance.checkIn', payload: { shiftId: 's1' } })).toEqual({ missing: ['memberId'] });
    expect(syncService.buildOperationRequest({ kind: 'nope', payload: {} })).toBeNull();
  });
});

describe('response → result mapping', () => {
  const op = { operationId: 'op-00000001', kind: 'shift.update' };
  const err = (code, extra = {}) => ({ error: { code, message: code, ...extra } });

  test('2xx → applied / duplicate (terminal)', () => {
    expect(syncService.mapResponse(op, { status: 201, body: { id: 'x' } })).toEqual({
      operationId: op.operationId,
      kind: op.kind,
      httpStatus: 201,
      status: 'applied',
      terminal: true,
      entity: { id: 'x' },
    });
    expect(syncService.mapResponse(op, { status: 200, body: { id: 'x' }, replayed: true }).status).toBe('duplicate');
    expect(syncService.mapResponse(op, { status: 204, body: null })).not.toHaveProperty('entity');
  });

  test('409 stale_write → conflict with currentVersion + currentRecord (not terminal)', () => {
    const r = syncService.mapResponse(op, { status: 409, body: err('stale_write', { currentVersion: 7, currentRecord: { id: 's', version: 7 } }) });
    expect(r).toMatchObject({ status: 'conflict', code: 'stale_write', terminal: false, currentVersion: 7, currentRecord: { id: 's', version: 7 } });
  });

  test('in-progress, 5xx, network, auth expiry, rate limit → retry (not terminal)', () => {
    expect(syncService.mapResponse(op, { status: 409, body: err('idempotency_in_progress') })).toMatchObject({ status: 'retry', terminal: false });
    expect(syncService.mapResponse(op, { status: 503, body: err('server') })).toMatchObject({ status: 'retry', terminal: false, code: 'server' });
    expect(syncService.mapResponse(op, { status: 500, body: null })).toMatchObject({ status: 'retry', code: 'server' });
    expect(syncService.mapResponse(op, { status: 0, body: err('network') })).toMatchObject({ status: 'retry', code: 'network' });
    expect(syncService.mapResponse(op, { status: 401, body: err('authentication_expired') })).toMatchObject({ status: 'retry' });
    expect(syncService.mapResponse(op, { status: 429, body: err('rate_limited', { retryAfterSeconds: 60 }) })).toMatchObject({
      status: 'retry',
      retryAfterSeconds: 60,
    });
  });

  test('every other 4xx → rejected (terminal)', () => {
    ['feature_disabled', 'not_permitted', 'not_found', 'validation', 'plan_limit_reached', 'attendance_window_expired', 'insufficient_stock', 'idempotency_conflict', 'conflict'].forEach(
      (code) => {
        const status = { feature_disabled: 403, not_permitted: 403, not_found: 404, validation: 422 }[code] || 409;
        expect(syncService.mapResponse(op, { status, body: err(code) })).toMatchObject({ status: 'rejected', terminal: true, code, httpStatus: status });
      },
    );
  });
});

describe('GET /sync/status', () => {
  test('latest seq + catalogue', async () => {
    const { tenant, main } = await f.tenantWithMainAdmin();
    const empty = await f.api().get('/api/v1/sync/status').set(f.auth(main.token)).expect(200);
    expect(empty.body.latestSeq).toBe(0);
    await f.group(tenant);
    await f.group(tenant);
    const res = await f.api().get('/api/v1/sync/status').set(f.auth(main.token)).expect(200);
    expect(res.body.latestSeq).toBe(2);
    expect(res.body.catalogue).toEqual(expect.arrayContaining(['inventory.movement.add', 'member.update']));
    expect(typeof res.body.serverTime).toBe('string');
    await f.api().get('/api/v1/sync/status').expect(401);
  });
});
