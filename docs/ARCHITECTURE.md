# Leader backend — architecture & conventions

Node.js 18+ · Express 4 · MongoDB 7 (Mongoose 8) · CommonJS.
This file is the rulebook every module follows. The frontend-facing guide is
`docs/FRONTEND-INTEGRATION-GUIDE.md`; per-module endpoint references are in
`docs/api/*.md`.

## 1. Folder layout

```
backend/
  server.js            boot: env → mongo → syncIndexes → listen → jobs
  app.js               express app: security, static /images, /api/v1 routes, errors
  config/              index.js (env) · constants.js (wire vocabularies) · capabilities.js (30 keys)
  models/              Mongoose schemas (one file per aggregate) + plugins/base.js; models/index.js exports all
  routes/              one router per module, mounted in routes/index.js; routes/platform/* = control plane
  controllers/         request handlers (controllers/auth, controllers/platform, controllers/tenant)
  validators/          Joi schemas per module
  middlewares/         requestId · versionGate · auth (chain) · idempotency · validate · upload · rateLimit
  services/            shared domain logic (tokens, audit, email, authorizations/seat, usage/limits,
                       storage, serializers, rollups, versioning, txn, settings, security)
  jobs/                interval runner + jobs/definitions/*.js
  seed/                npm run seed (fixtures.js = the seeded ids/emails)
  scripts/             local-mongo.js (npm run db) · build-postman.js
  postman/             modules/*.js (DSL) → Leader.postman_collection.json
  public/images/       uploaded images (served at /images/...)
  tests/               jest + supertest + mongodb-memory-server (replica set)
  docs/                this file, the frontend guide, api/*.md
```

## 2. The three planes

| Plane | Who | Mounted at | Guard |
|---|---|---|---|
| Identity | anyone / any session | `/api/v1/auth/**` | per route |
| Control plane | `super_admin` | `/api/v1/platform/**` | `platformGuard` |
| Tenant plane | `main_admin`, `admin` | everything else | `tenantGuard` |
| Customer Demo | `customer_demo` | `/api/v1/auth/customer-demo/**` only | refused by every tenant/platform endpoint |

The tenant is **always** derived from the verified account (`req.tenantId`),
never read from a request. A `super_admin` holds **no** capability key.

## 3. Wire conventions

- JSON, `camelCase`, UTF-8.
- **Success bodies are the resource itself** (no `{status, data}` wrapper):
  `GET /detachments` → `[Detachment, …]`, `GET /detachments/:id` → `Detachment`.
  Control-plane lists that page use `{ items, nextCursor, total? }`.
  A few feeds use a named envelope where the contract says so
  (`{ notifications: [...] }`, `{ announcements: [...] }`).
- `201` for creates, `200` for updates/commands returning a body, `204` (no
  body) for void.
- **Ids** are opaque prefixed strings (`d_01J…`). Seeded ids reuse the Flutter
  mock ids (`d_dam_central`, `saas_hilal`, `m1`). Never parse an id.
- **Time**: calendar days are `"YYYY-MM-DD"` in the tenant's timezone
  (`Shift.date`, `ShiftTemplate.dates`, `InventoryItem.expiresOn`).
  Everything else is an instant in RFC 3339 UTC (`…Z`). Instants received
  **without** an offset are read in the tenant timezone (`utils/time.parseInstant`).
- **Money** (commerce only): `{ "amount": 600, "currency": "USD" }`, integer minor units.
- **Images**: responses carry absolute URLs (`imageUrl`, `photoUrl`,
  `avatarUrl`, `coverImageUrl`, `logoUrl`) built from `PUBLIC_BASE_URL`;
  models store the relative `/images/...` path in `*Path`.

## 4. Errors

Every failure:

```json
{ "error": { "code": "not_found", "message": "detachment not found", "fields": {"name": "..."}, "reference": "req_01J…" } }
```

- `code` is the **only** thing clients branch on. `message` is diagnostics.
- Throw `AppError(code, httpStatus, message?, extensions?)`; helpers
  `AppError.validation(fields)`, `AppError.notFound(what)`,
  `AppError.notPermitted()`, `AppError.conflict()`.
- Extensions are merged into `error` (e.g. `currentVersion` + `currentRecord`
  on `stale_write`, `retryAfterSeconds` on `rate_limited`, `tenantStatus` on
  `tenant_unavailable`, `limitKey/limit/usage` on `plan_limit_reached`).

Core codes: `validation` 422 · `not_found` 404 · `not_permitted` 403 ·
`conflict` 409 · `stale_write` 409 · `authentication_expired` 401 ·
`onboarding_required` 403 · `mfa_required` 403 · `account_unavailable` 403 ·
`tenant_context_unavailable` 403 · `tenant_unavailable` 403 ·
`feature_disabled` 403 · `plan_limit_reached` 409 · `upgrade_required` 426 ·
`rate_limited` 429 · `idempotency_conflict` 409 · `idempotency_in_progress` 409 ·
`payload_too_large` 413 · `server` 500. Feature-owned codes are listed in each
`docs/api/*.md`.

## 5. The authorization chain

`middlewares/auth.js`:

```js
const { tenantGuard, requireFeature, requireCap, requireCapIn, requireAnyCapIn,
        requireCapAnywhere, loadTenantDoc, fromDoc, fromParam, fromBody } = require('../middlewares/auth');

router.use(tenantGuard);                         // session → mfa → account → surface → tenant lifecycle
router.get('/', requireFeature('workshops'), ctrl.list);
router.post('/', requireFeature('workshops'), requireCap('workshop.create'), validate(schema), ctrl.create);
router.patch('/:itemId',
  loadTenantDoc(InventoryItem, 'itemId', 'item'),            // 404 if not in this tenant → req.docs.item
  requireCapIn('inventory.item.manage', fromDoc('item')),    // scoped check on the item's detachment
  validate(schema), ctrl.update);
```

After `tenantGuard`: `req.auth.{account,session}`, `req.tenant`, `req.tenantId`,
`req.grant` (normalized capabilities), `req.tz` (tenant timezone).
After `platformGuard`: `req.auth.account` is a `super_admin`.

Order of refusals (never collapse two into one code): session →
onboarding tier → MFA → account lifecycle → surface → tenant lifecycle →
**feature** (`feature_disabled`) → **capability** (`not_permitted`) → **plan
limit** (`plan_limit_reached`, via `usageService.assertCanConsume(req.tenant, key)`).

Visibility for lists: `caps.visibleDetachmentIds(req.grant)` → `null` (all) or
an id list; `caps.detachmentsWith(req.grant, key)` likewise for one key.

## 6. Concurrency & idempotency

- Versioned models (`base` plugin `versioned: true`) carry `version` (starts 1).
  In an update controller:

  ```js
  const { assertVersion, saveVersioned } = require('../services/versioning');
  assertVersion(doc, req.body.version, serialize);   // client sent a stale version → 409 stale_write
  doc.name = req.body.name;
  await saveVersioned(doc, serialize);               // a concurrent writer won → 409 stale_write
  ```

  `version` in the request body is OPTIONAL (last-write-wins without it);
  responses always include the new `version`.
- Append-only resources (inventory movements, attendance corrections) are
  never versioned.
- `idempotent({ required })` middleware (`middlewares/idempotency.js`) honours
  `Idempotency-Key`. Required on: onboarding mutations, every control-plane
  command, Simple Admin invitations, announcement publish, checkout.
  Optional (enforced when present) on every other tenant write and on the
  `POST /sync/push` batch — each pushed operation's `operationId` is already
  that operation's Idempotency-Key.
- Multi-document atomic operations: `withTransaction(async (session) => {...})`
  from `services/txn.js` (pass `{ session }` to every write inside).

## 7. Shared services you must reuse

| Need | Use |
|---|---|
| TeamMember / Shift / InventoryItem / Movement / Workshop / Participant / Group / Detachment JSON | `services/serializers.js` (never raw `toJSON`) |
| Group & detachment roll-ups (memberCount, weeklyShiftCount, coveragePercent) | `services/rollups.js` |
| Plan limits / usage | `services/usageService.js` |
| Change-log entries for atomic updates that bypass `save()` | `services/changeLog.js` (`recordUpsert` / `recordDelete`) |
| Images | `middlewares/upload.imageUpload('image')` + `services/storageService.saveImage(buffer, preset, owner)` / `removeFile(path)` |
| Audit | `services/auditService.record({ action, actor, target, tenant, changes, stream })` |
| Email | `services/emailService.sendTemplate(to, kind, params)` |
| Tokens / sessions | `services/tokenService` |
| AuthUser / SessionAccess JSON | `services/sessionView` |
| Seat + invitation rules | `services/authorizationService` |
| Policy values (trial days, OTP, demo policy…) | `services/settingsService.get()` |
| Security signals / throttles | `services/securityService` |
| Time & days | `utils/time.js` (tenant tz = `req.tz`) |
| Normalization (names, emails, team/coupon codes, Arabic search folding) | `utils/normalize.js` |
| Cursors / limit param | `utils/cursor.js` |

## 8. Models (all in `models/`)

Identity: `Account`, `Session`, `VerificationChallenge`, `PasswordReset`,
`Authorization`. Control plane: `SaasTenant`, `TenantStatusEvent`,
`TenantTombstone`, `RetiredTeamCode`, `Plan`, `AppSettings`, `AuditEvent`,
`SecuritySignal`, `BreakGlassGrant`, `DemoSession`, `GlobalOffer`, `Coupon`,
`BillingOrder`, `CouponRedemption`. Tenant plane: `DetachmentGroup`,
`Detachment`, `TeamMember`, `Shift`, `ShiftTemplate`, `InventoryItem`,
`InventoryMovement`, `Workshop`, `WorkshopParticipant`, `Announcement`,
`NotificationState`. Infrastructure: `Counter`, `ChangeLog`,
`IdempotencyRecord`, `DevMail`, `StoredFile`, `JobRun`.

Tenant-plane documents always carry `tenantId` and every query MUST filter on
`tenantId: req.tenantId`. Deleting a tenant-plane document: use
`await doc.deleteOne()` (document middleware → change log), not
`Model.deleteOne(filter)`.

Field naming: anything ending in `Key` or `Hash`, or starting with `_`, is
stripped by `toJSON` — don't give an output field such a name.

## 9. Tests

`npm test` — Jest, supertest, one MongoDB 7 replica set per run, one database
per test file. Use `tests/helpers/factory.js`:

```js
const f = require('./helpers/factory');
const { tenant, main } = await f.tenantWithMainAdmin();
const det = await f.detachment(tenant);
await f.api().get(`/api/v1/detachments/${det._id}`).set(f.auth(main.token)).expect(200);
```

Every endpoint needs: a success test, its validation failure, its
authorization failure (wrong capability / wrong surface), and each business
rule's refusal code.

## 10. Postman

`postman/modules/NN-name.js` in the DSL documented at the top of
`scripts/build-postman.js`; `npm run postman:build` compiles, `npm run
postman:run` runs it with Newman against a seeded local server. Folders run in
`order`; `00-bootstrap` signs in the seeded accounts. A folder must never break
seeded data for later folders — destructive flows create their own records.

## 11. Seeded data

`npm run seed` (or `seed:reset`) — ids and emails in `seed/fixtures.js`. All
seeded accounts use `SEED_PASSWORD` (default `Leader@12345`):

| Account | Email | Role |
|---|---|---|
| Super Admin | nullmod.dev@gmail.com | super_admin |
| Main Admin (saas_hilal) | pbea4007@mtu.edu.iq | main_admin |
| Simple Admin (saas_hilal) | hamodekaherhm@gmail.com | admin (sub-admin preset in d_dam_central + d_homs) |

## 12. Module reference index

| Module | Doc | Routes |
|---|---|---|
| Identity, sessions, onboarding, MFA, reset | [api/auth.md](api/auth.md) | `routes/authRoutes.js` |
| Customer Demo | [api/customer-demo.md](api/customer-demo.md) | `routes/customerDemoRoutes.js`, `routes/platform/demoRoutes.js` |
| Tenants, lifecycle, subscription, features, Main Admin seat | [api/platform-tenants.md](api/platform-tenants.md) | `routes/platform/tenantsRoutes.js` |
| Plans, platform settings, platform admins, account lookup | [api/platform-configuration.md](api/platform-configuration.md) | `routes/platform/{plans,settings,admins,accounts}Routes.js` |
| Overview, health, security, audit, reports, analytics, jobs | [api/platform-insights.md](api/platform-insights.md) | `routes/platform/{insights,audit,reports,analytics,jobs}Routes.js` |
| Break-glass | [api/break-glass.md](api/break-glass.md) | `routes/platform/breakGlassRoutes.js` |
| Pricing, checkout, offers, coupons, billing orders | [api/commerce.md](api/commerce.md) | `routes/{pricing,billing}Routes.js`, `routes/platform/{commerce,billing}Routes.js` |
| Detachment groups, detachments, stats | [api/detachments.md](api/detachments.md) | `routes/detachment{Group,}Routes.js` |
| Members | [api/members.md](api/members.md) | `routes/memberRoutes.js` |
| Inventory | [api/inventory.md](api/inventory.md) | `routes/inventoryRoutes.js` |
| Shifts, templates, attendance, corrections | [api/shifts.md](api/shifts.md) | `routes/{detachmentShift,shift,shiftTemplate}Routes.js` |
| Workshops | [api/workshops.md](api/workshops.md) | `routes/workshop{,Participant}Routes.js` |
| Announcements | [api/announcements.md](api/announcements.md) | `routes/announcementRoutes.js` |
| Home, notifications, search | [api/home-notifications-search.md](api/home-notifications-search.md) | `routes/{home,notification,search}Routes.js` |
| Settings, organization, features, Simple Admins, tenant audit | [api/tenant-administration.md](api/tenant-administration.md) | `routes/{settings,tenant}Routes.js` |
| Tenant analytics | [api/tenant-analytics.md](api/tenant-analytics.md) | `routes/tenantRoutes.js` |
| Offline sync | [api/sync.md](api/sync.md) | `routes/syncRoutes.js` |

`npm run routes` prints every endpoint straight from the Express router;
`npm run routes:coverage` shows which ones the Postman collection exercises.
