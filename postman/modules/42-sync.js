/**
 * Offline sync — /sync/status, /sync/pull, /sync/push. docs/api/sync.md
 *
 * The push adds ONE inbound stock movement (+1 individual) to the seeded item
 * i1 — an append-only ledger write, so later folders are unaffected.
 */
module.exports = {
  name: 'Tenant · Sync',
  order: 42,
  description:
    'The server half of the Flutter outbox: push replays each operation against its REST endpoint (Idempotency-Key = operationId), pull serves the change feed after an opaque cursor.',
  items: [
    {
      name: 'Status (catalogue + head of the change feed)',
      method: 'GET',
      path: '/sync/status',
      expect: 200,
      tests: ['pm.expect(json.catalogue).to.include("inventory.movement.add")', 'pm.expect(json.latestSeq).to.be.a("number")'],
    },
    {
      name: 'Pull — since=now (bootstrap after a full read)',
      method: 'GET',
      path: '/sync/pull',
      query: { since: 'now' },
      expect: 200,
      tests: ['pm.expect(json.changes).to.eql([])', 'pm.expect(json.hasMore).to.eql(false)'],
      save: { syncHeadCursor: 'json.nextCursor' },
    },
    {
      name: 'Pull — from the beginning (page 1)',
      method: 'GET',
      path: '/sync/pull',
      query: { limit: 50 },
      expect: 200,
      tests: [
        'pm.expect(json.changes.length).to.be.at.most(50)',
        'const seqs = json.changes.map(function (c) { return c.seq; }); pm.expect(seqs).to.eql(seqs.slice().sort(function (a, b) { return a - b; }))',
      ],
      save: { syncPageCursor: 'json.nextCursor' },
    },
    {
      name: 'Pull — page 2',
      method: 'GET',
      path: '/sync/pull',
      query: { limit: 50, cursor: '{{syncPageCursor}}' },
      expect: 200,
      tests: ['pm.expect(json.changes).to.be.an("array")', 'pm.expect(json.nextCursor).to.be.a("string")'],
    },
    {
      name: 'Pull — invalid cursor → 422 validation',
      method: 'GET',
      path: '/sync/pull',
      query: { cursor: 'not-a-cursor' },
      expect: 422,
    },
    {
      name: 'Push — a movement, its replay, an unknown kind',
      method: 'POST',
      path: '/sync/push',
      prerequest: [
        'pm.collectionVariables.set("syncOpId", pm.variables.replaceIn("{{$guid}}"));',
        'pm.collectionVariables.set("syncOpId2", pm.variables.replaceIn("{{$guid}}"));',
      ],
      body: {
        operations: [
          {
            operationId: '{{syncOpId}}',
            kind: 'inventory.movement.add',
            payload: { itemId: 'i1', direction: 'inflow', quantity: 1, reason: 'مزامنة', packagingUnit: 'individual' },
          },
          {
            operationId: '{{syncOpId}}',
            kind: 'inventory.movement.add',
            payload: { itemId: 'i1', direction: 'inflow', quantity: 1, reason: 'مزامنة', packagingUnit: 'individual' },
          },
          { operationId: '{{syncOpId2}}', kind: 'inventory.teleport', payload: {} },
        ],
      },
      expect: 200,
      tests: [
        'pm.expect(json.results).to.have.lengthOf(3)',
        'pm.expect(json.results[0].status).to.eql("applied")',
        'pm.expect(json.results[1].status).to.eql("duplicate")',
        'pm.expect(json.results[2]).to.include({ status: "rejected", code: "unsupported_operation", terminal: true })',
      ],
    },
    {
      name: 'Push — the same batch again (every movement is now a duplicate)',
      method: 'POST',
      path: '/sync/push',
      body: {
        operations: [
          {
            operationId: '{{syncOpId}}',
            kind: 'inventory.movement.add',
            payload: { itemId: 'i1', direction: 'inflow', quantity: 1, reason: 'مزامنة', packagingUnit: 'individual' },
          },
        ],
      },
      expect: 200,
      tests: ['pm.expect(json.results[0].status).to.eql("duplicate")'],
    },
    {
      name: 'Push — empty batch → 422 validation',
      method: 'POST',
      path: '/sync/push',
      body: { operations: [] },
      expect: 422,
    },
    {
      name: 'Pull — after the head cursor (the pushed movement arrives)',
      method: 'GET',
      path: '/sync/pull',
      query: { cursor: '{{syncHeadCursor}}' },
      expect: 200,
      tests: ['pm.expect(json.changes.map(function (c) { return c.entityType; })).to.include("inventory_movement")'],
    },
  ],
};
