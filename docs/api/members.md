# Team members — `/detachments/:id/members`, `/members`

Volunteer roster records. A `TeamMember` is **never** a login account (only
administrators authenticate). Flutter: `TeamRepository` — the **team** tab of
`/detachment/:id`, `/detachment/:id/member/:memberId/edit` and `/status`, and
the quick-add in the shift assignment sheet.

Code: `routes/memberRoutes.js` (+ the roster read in
`routes/detachmentRoutes.js`), `controllers/tenant/{member,detachment}Controller.js`,
`validators/memberValidators.js`, shared `services/serializers.member`.
Tests: `tests/tenant-members.test.js` (+ roster ordering in `tests/tenant-structure.test.js`).
Postman: folder **Tenant · Team members** (`postman/modules/21-members.js`).

All errors use the shared envelope `{ "error": { "code", "message", "fields"?, …, "reference" } }`.
Every capability below is checked **in the member's detachment**.

| Endpoint | Capability | Success |
|---|---|---|
| `GET /detachments/:detachmentId/members?includeInactive=true` | `member.view` | `200 [TeamMember]` |
| `POST /members` | `member.invite` (body `detachmentId`) · limit `members` | `201 TeamMember` |
| `POST /members/from-shift` | `member.invite` · limit `members` | `201 TeamMember` |
| `GET /members/match?detachmentId=&name=` | `member.view` (query `detachmentId`) | `200 { match }` |
| `GET /members/:memberId` | `member.view` | `200 TeamMember` |
| `PUT /members/:memberId` | `member.edit` (+ `member.role.assign` to change `role`) | `200 TeamMember` |
| `PATCH /members/:memberId` | idem | `200 TeamMember` |
| `PATCH /members/:memberId/role` | `member.role.assign` | `200 TeamMember` |
| `PATCH /members/:memberId/attendance` | `shift.attendance.record` | `200 TeamMember` |
| `POST /members/:memberId/deactivate` | `member.deactivate` | `200 TeamMember` |
| `POST /members/:memberId/reactivate` | `member.deactivate` · limit `members` | `200 TeamMember` |
| `DELETE /members/:memberId` | `member.deactivate` | `204` |
| `POST /members/:memberId/photo` | `member.edit` (multipart `image`) | `200 TeamMember` |
| `DELETE /members/:memberId/photo` | `member.edit` | `200 TeamMember` |

Every write accepts an optional `Idempotency-Key`. A member of another tenant
is `404 not_found`. A platform / demo session is `403 tenant_context_unavailable`.

## 1. Wire shape — `TeamMember`

```json
{
  "id": "m1",
  "name": "أحمد كنعان",
  "initials": "أك",
  "department": "الإسعاف",
  "personalNumber": "101",
  "role": "shiftSupervisor",
  "detachmentId": "d_dam_central",
  "attendance": "notCheckedIn",
  "phoneMasked": "+963 9xx xxx 919",
  "photoUrl": "http://localhost:4000/images/members/member-m1-01j….webp",
  "active": true,
  "version": 4
}
```

- `role` — `shiftSupervisor | administrator | followUp | member`. Input also
  accepts the legacy `lead | medic | trainee | volunteer` (→ `shiftSupervisor |
  administrator | followUp | member`); the server always **stores and returns
  the new value**.
- `attendance` — the vestigial ROSTER value (`notCheckedIn | checkedIn |
  checkedOut | absent`; legacy input `present`/`late` → `checkedIn`,
  `notInvited` → `notCheckedIn`). Real attendance lives on each shift attendee.
- `phone` is stored in full (normalized: ASCII digits, optional `+`) but
  **never** leaves the server; `phoneMasked` is present only when the caller
  holds `member.contact.view` in the member's detachment.
- `initials` — first letter of the first two words; `photoUrl` omitted when none.

## 2. Roster — `GET /detachments/:detachmentId/members`

Active members only unless `includeInactive=true`. Sorted by role order
(`shiftSupervisor`, `administrator`, `followUp`, `member`), then name (Arabic
collation).

## 3. Create — `POST /members`

```http
POST /api/v1/members
Content-Type: application/json
Idempotency-Key: 01928c1e-…

{
  "detachmentId": "d_dam_central",
  "name": "خالد العمر",
  "department": "الإسعاف",
  "personalNumber": "١١٢",
  "role": "medic",
  "phone": "+963 944 555 666"
}
```

→ `201` with `role: "administrator"`, `personalNumber: "112"` (Arabic-Indic
digits folded), `attendance: "notCheckedIn"`, `active: true`, `version: 1`.

**Uniqueness inside one detachment** (inactive members included; enforced by
unique indexes, so a lost race answers the same codes):

| Rule | Code |
|---|---|
| same normalized name (trim, collapse spaces, case-insensitive) | `409 name_taken` (`fields.name`) |
| same non-empty `personalNumber` | `409 number_taken` (`fields.personalNumber`) |

The same name in **another** detachment is allowed.

### Quick member — `POST /members/from-shift`

`{ "detachmentId", "name" }` → `201` with `role: "member"` and an internal
`personalNumber` `shift-<n>` (a per-detachment counter, skipping any number
already in use). `name_taken` applies.

### Name match — `GET /members/match?detachmentId=d_dam_central&name=ليلى سعيد`

`{ "match": TeamMember }` for the same normalized name in that detachment, or
`{ "match": null }`. Used by the shift flow before offering «add as new member».

## 4. Edit

`PUT` = the form's editable fields: `{ id?, name, department, personalNumber, phone?, role?, version? }`.
`name`, `department` and `personalNumber` are replaced (`""` when absent).
`phone` and `role` are **optional — absent means unchanged**, because the
roster JSON a client holds carries only `phoneMasked` and must never wipe the
stored number; `phone: null` or `""` clears it. Fields such as `attendance`,
`detachmentId`, `phoneMasked` in the body are ignored. `PATCH` = any subset.

- A `role` different from the current one additionally needs
  `member.role.assign` (`403 not_permitted`); sending the current role is fine.
- `name_taken` / `number_taken` apply, excluding the member itself.
- `version` (optional) → `409 stale_write` with `currentVersion` + `currentRecord`.

`PATCH /members/:id/role` `{ "role": "trainee" }` and `PATCH
/members/:id/attendance` `{ "attendance": "present" }` are the legacy
single-field commands.

## 5. Lifecycle

- `POST /members/:id/deactivate` → `active: false` (stops counting towards the
  `members` limit and the roster; shift history keeps it).
- `POST /members/:id/reactivate` → `active: true`; refused with `409
  plan_limit_reached` (`limitKey: members`) when the plan is full.
- `DELETE /members/:id` → `204`; the photo file is removed; shift attendee and
  workshop organiser lines **keep the id** and render as a missing member
  («عضو محذوف»). The change log records the delete for sync.

## 6. Photo

`POST /members/:id/photo` (multipart field `image`; JPEG/PNG/WebP/GIF/HEIC)
→ re-encoded 512×512 WebP, `photoUrl` set, previous file removed. `DELETE
/members/:id/photo` clears it.

## 7. Errors

| Code | When |
|---|---|
| `403 not_permitted` | capability missing in the member's (or body/query) detachment |
| `404 not_found` | unknown member, or `detachmentId` not in the tenant (create) |
| `409 name_taken` | normalized name already used in the detachment |
| `409 number_taken` | personal number already used in the detachment |
| `409 plan_limit_reached` | create / reactivate beyond `members` (`limitKey`, `limit`, `usage`) |
| `409 stale_write` | stale `version` |
| `413 payload_too_large` | photo larger than `MAX_UPLOAD_MB` |
| `422 validation` | empty name (> 80), unknown role/attendance, malformed phone, missing `detachmentId`, no/unreadable image, body `id` ≠ path id |
