# Tenant analytics — `/tenant/analytics`

Read-only statistics over the tenant's operational records, computed on every
request (nothing is pre-aggregated, so a figure can never disagree with the
list behind it).

Code: `routes/tenantRoutes.js`, `controllers/tenant/tenantAnalyticsController.js`,
`services/tenantAnalyticsService.js`. Tests: `tests/tenant-analytics.test.js`.
Postman: folder **Tenant · Analytics** (`postman/modules/41-tenant-analytics.js`).

| Endpoint | Extra gates | Success |
|---|---|---|
| `GET /tenant/analytics/dashboard` | — | `200 Dashboard` |
| `GET /tenant/analytics/detachments/:detachmentId` | `stats.view` in THAT detachment | `200 DetachmentReport` |
| `GET /tenant/analytics/workshops` | module `workshops` | `200 WorkshopsReport` |
| `GET /tenant/analytics/inventory` | module `inventory` | `200 InventoryReport` |

Every endpoint: `tenantGuard` → **module `statistics_reports`**
(`403 feature_disabled`, `feature`) → **`stats.view` held anywhere**
(`403 not_permitted`). The feature check always comes first.

## Scope

Every figure covers only the detachments where the caller holds `stats.view`:
`caps.detachmentsWith(grant, 'stats.view')` — the Main Admin (held globally)
gets every **active** detachment; a Simple Admin with `stats.view` scoped to
`d_dam_central` + `d_homs` gets exactly those two (if active). Workshops are
organisation-level and are not detachment-scoped (any `stats.view` suffices).

## Range

Query `from`, `to` — calendar days `YYYY-MM-DD`, inclusive, in the tenant
timezone. Default: the last 30 days ending today (`to = today`,
`from = today − 29`). Only `to` → `from = to − 29`. Maximum 366 days.

| Refusal | When |
|---|---|
| `422 validation` `fields.from` / `fields.to` | not a calendar day, or `from` after `to` |
| `422 validation` `fields.range` | more than 366 days |

Shift days use `Shift.date` (the tenant-local start day). Instants
(`Workshop.at`, `InventoryMovement.at`) are bucketed by their tenant-local day.

## Metric definitions

| Metric | Definition |
|---|---|
| `shifts` | shifts dated in the range, in scope |
| `neededSlots` | Σ `needed` |
| `filledSlots` | Σ `min(assigned, needed)` (over-assignment never inflates coverage) |
| `coveragePercent` | `round(filledSlots / neededSlots × 100)`, `0` when no slot is needed |
| `attendancePercent` | `round(present / resolved × 100)`, `0` when nothing is resolved; `present = checkedIn + checkedOut`, `resolved = checkedIn + checkedOut + absent` (attendee rows) |
| `absences` | attendee rows `absent` |
| `pending` | attendee rows still `notCheckedIn` on a shift that has already ENDED (`endsAt < now`) |
| `members` | ACTIVE team members in scope |
| `detachments` | active detachments in scope |
| `workshops` | non-archived workshops whose `at` is in the range *(workshops module on)* |
| `workshopAttendancePercent` | the attendance formula over those workshops' participants *(workshops on)* |
| `lowStockItems` | items whose level is `low` or `empty` (stock below minimum) *(inventory on)* |
| `expiringItems` | items with `expiresOn ≤ today + 30`, already-expired included *(inventory on)* |
| `activeAnnouncements` | announcements `active`, published, not yet expired, addressed to a detachment in scope *(announcements on)* |
| `storageStatus` | worst-wins: no items → `empty`; any `empty` item → `depleted`; any `low` → `low`; any expiring → `expiring`; else `healthy` (same fold as the app's `storageStatusOf`) *(inventory on)* |
| stock `inflow` / `outflow` | Σ `convertedBaseUnitQuantity` (BASE units) of movements that day |

A figure of a module that is OFF is **omitted** (the key is absent), never `0`.
Daily series contain every day of the range (days without shifts read `0`).

## `GET /tenant/analytics/dashboard`

```json
{
  "range": { "from": "2026-08-30", "to": "2026-09-28" },
  "generatedAt": "2026-09-28T09:00:00.000Z",
  "kpis": {
    "detachments": 2, "members": 5, "shifts": 3, "neededSlots": 9, "filledSlots": 6,
    "coveragePercent": 67, "attendancePercent": 60, "absences": 2,
    "workshops": 2, "workshopAttendancePercent": 67,
    "lowStockItems": 2, "expiringItems": 1, "activeAnnouncements": 2
  },
  "series": {
    "coverage":   [{ "date": "2026-09-27", "percent": 57 }],
    "attendance": [{ "date": "2026-09-27", "percent": 50 }],
    "stockMovements": [{ "date": "2026-09-27", "inflow": 10, "outflow": 3 }]
  },
  "byDetachment": [
    { "detachmentId": "d_dam_central", "name": "مفرزة دمشق المركزية", "shifts": 2, "coveragePercent": 100, "attendancePercent": 75, "members": 3, "storageStatus": "low" }
  ],
  "topMembers": [
    { "memberId": "m1", "name": "أحمد", "detachmentId": "d_dam_central", "attended": 2, "absent": 0, "attendancePercent": 100 }
  ]
}
```

(Series truncated to one day in the example; the real arrays hold every day.)
`topMembers` — the 10 members with the most attended shift rows in the range
(ties: higher attendance %, then name). A deleted member reads `عضو محذوف`.

### Worked example (the test fixture)

| Shift | Detachment | Day | needed | attendees |
|---|---|---|---|---|
| S1 | A | T−1 | 3 | checkedOut, checkedIn, absent |
| S2 | A | T−2 | 2 | checkedIn, notCheckedIn (ended → pending) |
| S3 | B | T−1 | 4 | absent |
| S4 | A | T−40 | 2 | checkedIn — outside the default range |

`neededSlots = 3+2+4 = 9`, `filledSlots = 3+2+1 = 6` → coverage `round(66.7) = 67`.
`present = 3`, `resolved = 3 + 2 = 5` → attendance `60`. Day T−1: needed 7, filled 4 →
coverage `57`; attendance 2/4 → `50`. Detachment A: coverage `100`, attendance
3/4 → `75`; B: coverage `25`, attendance `0`. A Simple Admin holding
`stats.view` only in A sees `detachments 1, shifts 2, neededSlots 5, coveragePercent 100, attendancePercent 75`.

## `GET /tenant/analytics/detachments/:detachmentId`

`404 not_found` for an unknown (or other tenant's) detachment, then
`403 not_permitted` without `stats.view` in it. Archived detachments can be read.

```json
{
  "detachment": { "id": "d_dam_central", "name": "مفرزة دمشق المركزية" },
  "range": { "from": "2026-08-30", "to": "2026-09-28" },
  "generatedAt": "2026-09-28T09:00:00.000Z",
  "kpis": {
    "members": 3, "shifts": 2, "neededSlots": 5, "filledSlots": 5, "coveragePercent": 100,
    "attendancePercent": 75, "absences": 1,
    "lowStockItems": 1, "expiringItems": 1, "storageStatus": "low", "activeAnnouncements": 1
  },
  "series": { "coverage": [], "attendance": [], "stockMovements": [] },
  "members": [
    { "memberId": "m1", "name": "أحمد", "role": "shiftSupervisor", "shifts": 2, "attended": 2, "absent": 0, "pending": 0, "attendancePercent": 100 },
    { "memberId": "m2", "name": "باسل", "role": "member", "shifts": 2, "attended": 1, "absent": 0, "pending": 1, "attendancePercent": 100 }
  ],
  "centers": [
    { "centerName": "مركز الشعلان", "shifts": 1, "coveragePercent": 100 }
  ]
}
```

`kpis` is the detachment-level subset of the dashboard KPIs (no `detachments`,
no organisation-level `workshops`), plus `storageStatus`. `members` = every
ACTIVE member of the detachment plus anyone who worked one of its shifts in the
range; sorted by attended, then shifts, then name. `members[].attendancePercent`
= `attended / (attended + absent)`. `centers` groups the range's shifts by
`centerName`.

## `GET /tenant/analytics/workshops`

Workshops (not archived) whose `at` falls in the range.

```json
{
  "range": { "from": "2026-09-18", "to": "2026-10-08" },
  "generatedAt": "2026-09-28T09:00:00.000Z",
  "count": 3,
  "byStatus": { "scheduled": 1, "ongoing": 0, "done": 2 },
  "participants": 5,
  "attendancePercent": 67,
  "payments": { "paid": 2, "unpaid": 2, "totalCollected": 50000 },
  "byMonth": [ { "month": "2026-09", "workshops": 2, "participants": 4 }, { "month": "2026-10", "workshops": 1, "participants": 1 } ]
}
```

- `participants` — register rows (members + guests; organisers take no seat and are not counted).
- `payments` — only workshops with `registrationFee > 0`: `paid` = rows with
  `paymentStatus: paid`; `unpaid` = every other row of a paid workshop;
  `totalCollected = Σ registrationFee × paid` (plain number, tenant currency — the app renders ل.س).
- `byMonth` — every month the range touches (`YYYY-MM`, tenant tz), zeros included.

## `GET /tenant/analytics/inventory`

`?detachmentId` narrows to one detachment (`404` unknown, `403` without
`stats.view` in it); otherwise every detachment in scope. Also takes the range
(for `movements`).

```json
{
  "range": { "from": "2026-08-30", "to": "2026-09-28" },
  "generatedAt": "2026-09-28T09:00:00.000Z",
  "items": 3,
  "byLevel": { "ok": 1, "low": 1, "empty": 1 },
  "expiring": [
    { "itemId": "i1", "name": "شاش معقم", "detachmentId": "d_dam_central", "expiresOn": "2026-10-08", "daysLeft": 10 }
  ],
  "movements": [ { "date": "2026-09-27", "inflow": 10, "outflow": 3 } ]
}
```

`expiring` — items with `expiresOn ≤ today + 30` (expired ones have a negative
`daysLeft`), soonest first. `level`: stock 0 → `empty`, below minimum → `low`, else `ok`.
