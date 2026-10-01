# Platform · Configuration — plans, settings, admins, accounts

Super Admin configuration of the Leader platform itself: the **plan catalogue**
(platform settings → plans; read by the tenant detail → subscription/limits
tabs), **platform policy settings** (platform settings), **platform
administrators** (platform settings → administrators) and the cross-tenant
**account lookup** (platform operations → accounts: support and coupon targeting).

Code: `routes/platform/{plans,settings,admins,accounts}Routes.js` ·
`controllers/platform/{plans,settings,admins,accounts}Controller.js` ·
`validators/platformConfigValidators.js` · shared `settingsService`,
`auditService`, `tokenService`.
Tests: `tests/platform-config.test.js`.
Postman: folder **Platform · Configuration** (`postman/modules/11-platform-config.js`).

**Every route:** `platformGuard` (active, MFA-satisfied `super_admin`); a tenant
or demo session → `403 not_permitted`. Writes honour an `Idempotency-Key` when
one is sent (optional here).

| # | Endpoint | Success |
|---|---|---|
| 27 | `GET /platform/plans` | `200 [Plan]` |
| 28 | `POST /platform/plans` | `201 Plan` |
| 29 | `PATCH /platform/plans/:planId` | `200 Plan` |
| 30 | `DELETE /platform/plans/:planId` | `204` |
| 31 | `GET /platform/settings` | `200 PlatformSettings` |
| 32 | `PATCH /platform/settings` | `200 PlatformSettings` |
| 33 | `GET /platform/admins` | `200 [PlatformAdmin]` |
| 34 | `POST /platform/admins` | `201 PlatformAdmin` |
| 35 | `POST /platform/admins/:accountId/suspend` | `200 PlatformAdmin` |
| 36 | `POST /platform/admins/:accountId/reactivate` | `200 PlatformAdmin` |
| 37 | `GET /platform/accounts?search&role&tenantId&status&cursor&limit` | `200 { items, nextCursor }` |
| 38 | `GET /platform/accounts/:accountId` | `200 AccountLookup + activeSessions` |
| 39 | `POST /platform/accounts/:accountId/sign-out-all` | `200 { revoked }` |

---

## Plans

A plan is a reusable **limit definition** referenced by id from
`SaasTenant.subscription.planId` — never copied into tenants
(`effective = tenant override ?? plan default`). Plans carry **no price**:
prices are the commerce billing options.

```json
{
  "id": "mtm_standard",
  "name": "ليدر القياسية",
  "description": "للفرق النشطة متعددة المفارز.",
  "recommended": true,
  "selectable": true,
  "defaultLimits": { "detachment_groups": 5, "detachments": 15, "admins": 8, "members": 300, "workshops": 40, "storage_bytes": 21474836480 }
}
```

`selectable: false` keeps a plan readable for tenants already on it but refuses
it as a **new** selection (`409 plan_unavailable` on activate / plan change).

### 27. `GET /platform/plans`

The catalogue ordered by its internal `order` (new plans are appended).

### 28. `POST /platform/plans`

```json
{
  "id": "mtm_pilot",
  "name": "ليدر التجريبية",
  "description": "خطة تجريبية للفرق الناشئة.",
  "recommended": false,
  "selectable": true,
  "defaultLimits": { "detachment_groups": 3, "detachments": 8, "admins": 4, "members": 120, "workshops": 20, "storage_bytes": 10737418240 }
}
```

`id` matches `^[a-z0-9_]{3,40}$` and is permanent; `name` 1–80 (collapsed);
`description` ≤ 500 (default `""`); `recommended` default `false`; `selectable`
default `true`; `defaultLimits` must carry **all six** keys as integers ≥ 0
(storage in bytes). Audit `plan_created` (target `plan`).

### 29. `PATCH /platform/plans/:planId`

Partial: any of `name`, `description`, `recommended`, `selectable`,
`defaultLimits` (itself partial — the given keys are merged). The `id` cannot
change. Audit `plan_updated`. Tenants on the plan see new defaults immediately
(their explicit overrides stay).

### 30. `DELETE /platform/plans/:planId`

`204` when no tenant references the plan; otherwise `409 conflict` — mark it
`selectable: false` instead.

| Error | When |
|---|---|
| `422 validation` | bad `id`, missing/negative/non-integer limit, empty PATCH body |
| `409 conflict` | duplicate `id` (create); plan still assigned (delete) |
| `404 not_found` | unknown `planId` (patch/delete) |

---

## Settings

The platform policy values (one `AppSettings` document). The Customer Demo
policy is **not** part of this resource (see customer-demo / `/platform/demo`).

```json
{
  "minimumClientVersion": "1.0.0",
  "defaultTimezone": "Asia/Damascus",
  "trialDays": 14,
  "graceDays": 14,
  "deletionWindowDays": 30,
  "breakGlassMinutes": 60,
  "invitationDays": 7,
  "idempotencyRetentionDays": 7,
  "attendanceGraceMinutes": 60,
  "recentAuthMinutes": 30,
  "otp": { "length": 6, "ttlMinutes": 10, "maxAttempts": 5, "resendCooldownSeconds": 60 },
  "signInLockout": { "maxFailures": 5, "windowMinutes": 15 },
  "support": { "email": "support@leader.app", "telegram": "", "whatsapp": "" },
  "updatedAt": "2026-09-28T09:00:00.000Z"
}
```

| Key | Meaning | Range |
|---|---|---|
| `minimumClientVersion` | below it every request answers `426 upgrade_required` | semver `x.y.z` |
| `defaultTimezone` | timezone of newly registered tenants | IANA zone |
| `trialDays` | trial length at registration | 1–365 |
| `graceDays` | grace length after `trial/end` or `grace` | 0–365 |
| `deletionWindowDays` | `scheduledFor = requestedAt + window` on deletion/begin | 0–365 |
| `breakGlassMinutes` | break-glass grant duration | 5–1440 |
| `invitationDays` | Main/Simple Admin invitation validity | 1–90 |
| `idempotencyRetentionDays` | how long Idempotency-Key results are kept | 1–90 |
| `attendanceGraceMinutes` | attendance recording grace after a shift | 0–1440 |
| `recentAuthMinutes` | freshness required by privileged seat commands | 1–1440 |
| `otp.length` / `ttlMinutes` / `maxAttempts` / `resendCooldownSeconds` | email code policy | 4–10 / 1–60 / 1–20 / 0–3600 |
| `signInLockout.maxFailures` / `windowMinutes` | password sign-in throttle | 1–100 / 1–1440 |
| `support.email` / `telegram` / `whatsapp` | support contacts shown in the apps | email or `""` / ≤ 200 / ≤ 200 |

### 31. `GET /platform/settings` → the shape above.

### 32. `PATCH /platform/settings`

Partial; nested groups patch **key by key** (`{ "otp": { "length": 8 } }` keeps
the other OTP values).

```json
{ "trialDays": 21, "otp": { "length": 8 }, "support": { "telegram": "@leader_support" } }
```

→ `200` the full settings. When at least one value changed, audit
`platform_settings_changed` lists the changed keys
(`[{ field: "setting_value", before: "trialDays", after: "trialDays" }, …]` — keys
only, never values). New values apply within seconds (5 s cache) and only to
what happens next (existing trials, grace periods and deletion schedules keep
their stored instants).

| Error | When |
|---|---|
| `422 validation` | out-of-range value, bad semver/timezone/email, empty body |

---

## Platform admins

```json
{ "id": "u_demo_platform", "name": "مدير منصة ليدر", "email": "nullmod.dev@gmail.com", "status": "active",
  "mfaEnabled": false, "lastLoginAt": "2026-09-28T08:00:00.000Z", "createdAt": "2025-01-01T09:00:00.000Z" }
```

### 33. `GET /platform/admins` → every `super_admin`, oldest first.

### 34. `POST /platform/admins`

```json
{ "name": "مشغّل المنصة", "email": "ops@leader.app", "password": "Leader@Ops2026" }
```

Creates an active `super_admin` (email verified, setup completed, no tenant, no
capability key). `password` 8–128 characters; it is hashed and never returned.
Audit `platform_admin_created`.

### 35. `POST /platform/admins/:accountId/suspend` `{ "reason": "انتهاء التكليف" }`

`active → suspended`, every session of the account is ended (its next request →
`401 authentication_expired`); the account stays suspended until reactivated.
You cannot suspend yourself. Audit `platform_admin_suspended`.

### 36. `POST /platform/admins/:accountId/reactivate`

`suspended → active` (no session is restored). Audit `platform_admin_reactivated`.

| Error | When |
|---|---|
| `422 validation` | name 1–80, email, password < 8, suspend without a 1–280 reason |
| `409 conflict` | email already used (create); suspend yourself; suspend a non-active / reactivate a non-suspended admin |
| `404 not_found` | `accountId` is not a Super Admin |

---

## Accounts lookup

```json
{
  "id": "u_demo_main",
  "name": "سلمى الحارثي",
  "email": "pbea4007@mtu.edu.iq",
  "role": "main_admin",
  "status": "active",
  "saasTenantId": "saas_hilal",
  "tenantName": "فرق الهلال الطبية",
  "emailVerified": true,
  "methods": ["password"],
  "lastLoginAt": "2026-09-28T08:00:00.000Z",
  "createdAt": "2025-01-04T16:00:00.000Z"
}
```

`role` is `super_admin | main_admin | admin | customer_demo` or `null` (an
identity that has not completed setup). Never returns credentials, MFA material,
session tokens, devices or IPs.

### 37. `GET /platform/accounts`

| Query | Rule |
|---|---|
| `search` | case-insensitive substring of name or email |
| `role` | exact role |
| `tenantId` | accounts of one tenant (`saasTenantId`) |
| `status` | `active \| suspended \| revoked \| pending_setup` |
| `cursor` / `limit` | opaque cursor; limit 1–100, default 50 |

Newest first → `{ "items": [AccountLookup], "nextCursor": "…" | null }`.

### 38. `GET /platform/accounts/:accountId`

The lookup row plus `activeSessions` (live, unrevoked sessions).

### 39. `POST /platform/accounts/:accountId/sign-out-all`

Ends every session and refresh token of the account → `{ "revoked": 2 }`.
Support uses it after a suspected credential leak; the person signs in again.

| Error | When |
|---|---|
| `422 validation` | unknown `role`/`status`, bad `limit`, malformed `cursor` |
| `404 not_found` | unknown `accountId` |
