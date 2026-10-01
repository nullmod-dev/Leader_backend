# Offline sync — `/sync`

The server half of the Flutter local-first outbox
(`FRONTEND-BACKEND-INTEGRATION.md` §3 and §5): **push** replays queued writes,
**pull** serves the per-tenant change feed after an opaque cursor.

Code: `routes/syncRoutes.js`, `controllers/tenant/syncController.js`,
`services/syncService.js`, `validators/syncValidators.js`.
Tests: `tests/sync-push.test.js`, `tests/sync-pull.test.js`.
Postman: folder **Tenant · Sync** (`postman/modules/42-sync.js`).

| Endpoint | Guard | Success |
|---|---|---|
| `POST /sync/push` | tenant (`Idempotency-Key` optional on the batch) | `200 { results, serverTime }` |
| `GET /sync/pull` | tenant | `200 { changes, nextCursor, hasMore, serverTime }` |
| `GET /sync/status` | tenant | `200 { serverTime, latestSeq, catalogue }` |

"tenant" = `tenantGuard`; a platform/demo session answers `403 tenant_context_unavailable`.

---

## 1. Push

### Principles

- **One logical write = one `operationId`** — the outbox's UUIDv7, minted once
  in `OutboxController.enqueue`, and it **is** the `Idempotency-Key` of the
  replayed request. Retrying an operation (this run, a later run, after a
  restart) sends the same id; the server applies it at most once.
- **A replayed write carries no authority of its own.** Each operation is
  dispatched as an internal loopback HTTP request to the REST endpoint that
  owns it, with the caller's own bearer. Validation, the authorization chain
  (feature → capability → plan limit), optimistic concurrency (`version` →
  `stale_write`) and idempotency are exactly those of a live request, evaluated
  **at replay time** against the caller's CURRENT grant.
- Operations run **sequentially, in the order sent**. A failed operation does
  not stop the batch.
- `X-Client-Version` is forwarded, so the forced-upgrade gate applies to each
  operation too.

### Request

```http
POST /api/v1/sync/push
Authorization: Bearer <access>
X-Client-Version: 1.4.0
Content-Type: application/json

{
  "operations": [
    {
      "operationId": "0192f3c4-7a1e-7b3c-9d10-5f2a8c1e4b77",
      "kind": "inventory.movement.add",
      "payload": { "itemId": "i1", "direction": "outflow", "quantity": 2, "reason": "شفت الصباح", "packagingUnit": "individual" }
    },
    {
      "operationId": "0192f3c4-7b02-7c11-8a44-0e9b3d6f2a10",
      "kind": "shift.update",
      "payload": { "shiftId": "sh_01J…", "needed": 4 },
      "version": 3
    }
  ]
}
```

| Field | Rule |
|---|---|
| `operations` | 1–50 items |
| `operationId` | 8–64 chars of `[A-Za-z0-9:_-.]` (a UUIDv7) — used as `Idempotency-Key` |
| `kind` | a catalogue kind (below); an unknown kind is rejected per operation, not per batch |
| `payload` | object; path identifiers (`itemId`, `shiftId`, `memberId`, `participantId`) are taken out of it, the rest is the request body |
| `version` | optional integer ≥ 1 — merged into the body as `version` (optimistic concurrency) |

Batch refusals (the whole request): `401 authentication_expired`,
`403 tenant_context_unavailable` / `tenant_unavailable` / `account_unavailable`,
`422 validation` (`fields["operations[0].operationId"]` …), `426 upgrade_required`.
An `Idempotency-Key` on the batch itself makes the whole result set replayable.

### Kind catalogue

`syncService.CATALOGUE` (also `GET /sync/status` → `catalogue`):

| kind | Method + path | Body (from `payload`) |
|---|---|---|
| `inventory.movement.add` | `POST /inventory-items/{itemId}/movements` | `direction, quantity, reason, packagingUnit` — append-only, **no `version`** |
| `shift.attendance.checkIn` | `POST /shifts/{shiftId}/members/{memberId}/check-in` | `at?` |
| `shift.attendance.checkOut` | `POST /shifts/{shiftId}/members/{memberId}/check-out` | `at?` |
| `shift.attendance.absent` | `POST /shifts/{shiftId}/members/{memberId}/absent` | — |
| `shift.attendance.reset` | `POST /shifts/{shiftId}/members/{memberId}/reset` | — |
| `shift.attendance.mark` | `PATCH /shifts/{shiftId}/members/{memberId}/attendance` | `attendance` |
| `shift.attendance.correct` | `POST /shifts/{shiftId}/members/{memberId}/attendance-corrections` | `status, checkInAt?, checkOutAt?, reason, correctedAt?` — append-only |
| `shift.assign` | `POST /shifts/{shiftId}/assignments` | `memberId` |
| `shift.unassign` | `DELETE /shifts/{shiftId}/assignments/{memberId}` | — |
| `shift.update` | `PATCH /shifts/{shiftId}` | the changed fields (+ `version`) |
| `member.update` | `PATCH /members/{memberId}` | the changed fields (+ `version`) |
| `workshop.participant.attendance` | `PATCH /workshop-participants/{participantId}/attendance` | `attendance` |
| `workshop.participant.payment` | `PATCH /workshop-participants/{participantId}/payment` | `paymentStatus` |

Note `shift.assign`: `memberId` is NOT a path parameter there, so it stays in the body.
A missing/empty path identifier → the operation is `rejected` with `code: validation`,
`fields: { "payload.shiftId": "…" }`, and no request is made.
Each target endpoint's own reference (`docs/api/*.md`) defines its body and its feature-owned codes.

### Response

```json
{
  "results": [
    {
      "operationId": "0192f3c4-7a1e-7b3c-9d10-5f2a8c1e4b77",
      "kind": "inventory.movement.add",
      "status": "applied",
      "httpStatus": 201,
      "terminal": true,
      "entity": { "id": "mv_01J…", "itemId": "i1", "direction": "outflow", "quantity": 2, "…": "…" }
    },
    {
      "operationId": "0192f3c4-7b02-7c11-8a44-0e9b3d6f2a10",
      "kind": "shift.update",
      "status": "conflict",
      "httpStatus": 409,
      "code": "stale_write",
      "message": "The record changed since you last read it.",
      "terminal": false,
      "currentVersion": 5,
      "currentRecord": { "id": "sh_01J…", "version": 5, "…": "…" }
    }
  ],
  "serverTime": "2026-09-28T09:00:00.000Z"
}
```

One result per operation, same order. `entity` = the endpoint's success body
(absent for `204`). `code`/`message`/`fields` = the endpoint's error. `httpStatus`
is the endpoint's status (`0` = no HTTP response at all, `code: network`).

### Result statuses

| `status` | When (endpoint answer) | `terminal` | Outbox action (Flutter) |
|---|---|---|---|
| `applied` | 2xx | `true` | `SyncState.synced` → remove |
| `duplicate` | 2xx with `Idempotent-Replayed: true` (this `operationId` was already applied; the ORIGINAL response is in `entity`) | `true` | same as applied |
| `conflict` | `409 stale_write` (`currentVersion` + `currentRecord` copied) | `false` | `SyncState.conflict` → Needs Review (`useLocal` mints a NEW operation with the current version; `useCurrent` discards) |
| `retry` | `409 idempotency_in_progress`; any `5xx`; network error/timeout; `401 authentication_expired`; `426 upgrade_required`; `429 rate_limited` (+ `retryAfterSeconds`) | `false` | keep pending, same `operationId`, retry later (refresh the token / upgrade first where the code says so) |
| `rejected` | every other 4xx: `validation`, `not_found`, `not_permitted`, `feature_disabled`, `plan_limit_reached`, `attendance_window_expired`, `insufficient_stock`, `conflict`, `idempotency_conflict`, … — plus `unsupported_operation` (unknown kind, no request made) | `true` | `SyncState.failed` permanently — the write cannot succeed as sent; surface `code` |

`terminal: true` = this operation's lifecycle is over (remove it from the
outbox, whether applied or refused); `terminal: false` = keep it.

`idempotency_conflict` means the SAME `operationId` was sent with a DIFFERENT
body — a client protocol fault (§5.2: never fold it into `stale_write`).

## 2. Pull

```http
GET /api/v1/sync/pull?cursor=eyJ2IjoxLCJzZXEiOjEyMH0&limit=200
```

| Query | Rule |
|---|---|
| `cursor` | opaque, from a previous `nextCursor`; absent = from the beginning |
| `limit` | 1–500, default 200 (change-log rows per page, before collapse) |
| `since=now` | no changes, `nextCursor` at the current head — the bootstrap after a full REST read |

```json
{
  "changes": [
    { "seq": 121, "entityType": "team_member", "entityId": "m1", "op": "upsert", "version": 4, "record": { "id": "m1", "name": "…", "version": 4 } },
    { "seq": 125, "entityType": "shift", "entityId": "sh_01J…", "op": "delete", "version": 2 }
  ],
  "nextCursor": "eyJ2IjoxLCJzZXEiOjEyNX0",
  "hasMore": false,
  "serverTime": "2026-09-28T09:00:00.000Z"
}
```

- Source: the per-tenant `change_log` (written by the model layer on every
  create/update/delete of a synced entity), `seq` ascending, `seq > cursor`.
- **Collapse**: within one page, only the LAST change per entity is emitted (keeping its `seq`).
- `upsert` carries the CURRENT document in the entity's ordinary wire shape
  (the same serializers as the REST reads) and its `version`. If the document
  no longer exists, the change is emitted as `delete`.
- `delete` (tombstone) carries no `record`.
- `entityType` → wire shape: `detachment_group` → DetachmentGroup (with roll-ups),
  `detachment` → Detachment (with roll-ups), `team_member` → TeamMember
  (`phoneMasked` per the caller's `member.contact.view`), `shift` → Shift,
  `shift_template` → ShiftTemplate, `inventory_item` → InventoryItem,
  `inventory_movement` → InventoryMovement, `workshop` → Workshop (register counts),
  `workshop_participant` → WorkshopParticipant, `announcement` → Announcement.
- **Visibility** (the caller's CURRENT grant): entities of detachments outside
  `visibleDetachmentIds` are skipped; a group is visible when it contains a
  visible detachment; workshops and participants are organisation-level; an
  announcement is visible when addressed to a visible detachment. An entity
  that just LEFT the caller's scope (e.g. a member transferred away) is emitted
  as `delete` so the device drops its copy.
- **Modules**: `inventory_*`, `workshop*` and `announcement` changes are
  skipped while their module is off.
- Always read until `hasMore: false`; keep the last `nextCursor` (it is
  returned even when `changes` is empty and must be stored verbatim — never
  parse it).
- `422 validation` for a malformed cursor, `limit` out of range, or `since` other than `now`.

## 3. Status

```json
{ "serverTime": "2026-09-28T09:00:00.000Z", "latestSeq": 1432, "catalogue": ["inventory.movement.add", "…"] }
```

## 4. Sequences

```mermaid
sequenceDiagram
    participant UI as Feature (e.g. storage tab)
    participant OB as OutboxController
    participant SC as SyncCoordinator / SyncTransport
    participant API as POST /sync/push
    participant EP as Owning endpoint (loopback)

    UI->>UI: local write succeeds
    UI->>OB: enqueue(kind, entity) → operationId (UUIDv7)
    Note over OB: persisted, state pending
    SC->>OB: pending operations (isRetryable)
    SC->>API: { operations: [{operationId, kind, payload, version?}] }
    loop each operation, in order
        API->>EP: METHOD /api/v1/... + Bearer + Idempotency-Key: operationId
        EP-->>API: 2xx | 409 stale_write | 4xx | 5xx (+ Idempotent-Replayed)
    end
    API-->>SC: { results: [{operationId, status, terminal, ...}] }
    SC->>OB: applied/duplicate → synced; conflict → conflict; retry → keep; rejected → failed
```

```mermaid
sequenceDiagram
    participant APP as App (sync loop)
    participant REST as REST reads
    participant PULL as GET /sync/pull

    APP->>REST: first launch: full reads (detachments, members, shifts…)
    APP->>PULL: ?since=now
    PULL-->>APP: { changes: [], nextCursor: C0 }
    Note over APP: store C0
    loop on resume / after a push / periodically
        APP->>PULL: ?cursor=Cn&limit=200
        PULL-->>APP: { changes, nextCursor: Cn+1, hasMore }
        APP->>APP: apply upserts (replace by id, keep newer version) and deletes
        Note over APP: store Cn+1; repeat while hasMore
    end
```

## 5. Wiring the Flutter client

- **`SyncTransport`** (`lib/core/sync/sync_transport.dart`): implement a batch
  push over `POST /sync/push`. `PendingOperation` is payload-free, so the
  transport asks the owning feature for the typed payload (keyed by
  `entityType`/`entityId`/`operationId`) and sends
  `{operationId, kind, payload, version?}`. Map each result:
  `applied`/`duplicate` → `Success`; `conflict` → `Failure(code: 'stale_write')`
  (the default classifier routes it to `SyncState.conflict`; hand
  `currentRecord` to the feature's conflict snapshot store); `retry` →
  `Failure(code)` with the operation left pending (`idempotency_in_progress`
  must never be shown as an error); `rejected` → `Failure(code)`,
  not retried automatically. A transport-level failure of the batch itself
  (offline / timeout) → `Offline()`; `401` → refresh and retry the batch.
- One-operation-at-a-time pushes are also valid (a batch of one) — the result
  mapping is identical.
- **`useLocal`** (`OutboxController.supersedeConflict`) mints a NEW
  `operationId` and sends `version: <currentVersion>`; never resend the old
  id with a changed body (that is `idempotency_conflict`).
- **Pull**: store `nextCursor` next to the outbox (encrypted store), bootstrap
  with `?since=now` after the first full read, then drain pages until
  `hasMore: false`.
- Server idempotency retention is `AppSettings.idempotencyRetentionDays`
  (default 7). A replay after that window executes again, so the outbox
  should not hold operations longer than that without surfacing them.
