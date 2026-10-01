# Inventory — `/detachments/:id/inventory-*`, `/inventory-items`

A detachment's store: items with packaging, and an **append-only movement
ledger** that is the only way stock changes. Flutter: `InventoryRepository` —
the **storage** tab of `/detachment/:id` and the stock item sheet.

Code: `routes/inventoryRoutes.js` (+ the two detachment reads in
`routes/detachmentRoutes.js`), `controllers/tenant/inventoryController.js`,
`validators/inventoryValidators.js`, shared `services/serializers.{inventoryItem,movement}`.
Tests: `tests/tenant-inventory.test.js`.
Postman: folder **Tenant · Inventory** (`postman/modules/22-inventory.js`).

Every route requires the tenant module **`inventory`** (`403 feature_disabled`,
`feature: "inventory"`). Capabilities are checked in the item's detachment.

| Endpoint | Capability | Success |
|---|---|---|
| `GET /detachments/:detachmentId/inventory-items` | `detachment.view` | `200 [InventoryItem]` (by name) |
| `GET /detachments/:detachmentId/inventory-movements?limit=50` | `detachment.view` | `200 [InventoryMovement]` newest first |
| `POST /inventory-items` | `inventory.item.manage` (body `detachmentId`) | `201 InventoryItem` |
| `GET /inventory-items/:itemId` | `detachment.view` | `200 InventoryItem` |
| `PUT /inventory-items/:itemId` | `inventory.item.manage` | `200 InventoryItem` |
| `PATCH /inventory-items/:itemId` | `inventory.item.manage` | `200 InventoryItem` |
| `DELETE /inventory-items/:itemId` | `inventory.item.manage` | `204` |
| `GET /inventory-items/:itemId/movements?limit=50` | `detachment.view` | `200 [InventoryMovement]` newest first |
| `POST /inventory-items/:itemId/movements` | `inventory.adjust` | `200 InventoryItem + lastMovement` |
| `POST /inventory-items/:itemId/image` | `inventory.item.manage` (multipart `image`) | `200 InventoryItem` |
| `DELETE /inventory-items/:itemId/image` | `inventory.item.manage` | `200 InventoryItem` |

`limit` is 1–200 (default 50). Every write accepts an optional
`Idempotency-Key` — for movements it is what makes an offline retry safe: a
replay returns the original response and records nothing new. Movements have
**no edit or delete endpoint**.

## 1. Wire shapes

### InventoryItem

```json
{
  "id": "i2",
  "detachmentId": "d_dam_central",
  "name": "باراسيتامول ٥٠٠ ملغ",
  "unit": "وحدة",
  "currentStock": 72,
  "minimum": 240,
  "level": "low",
  "expiresOn": "2027-01-26",
  "unitsPerStrip": 12,
  "stripsPerCarton": 10,
  "preferredUnit": "strip",
  "imageUrl": "http://localhost:4000/images/inventory/inventory_item-i2-01j….webp",
  "version": 7
}
```

- `currentStock` / `minimum` are **base units** (individual pieces).
- `level` (derived, stored): `currentStock == 0 → empty`; `currentStock <
  minimum → low`; else `ok`.
- `expiresOn` — a calendar day `YYYY-MM-DD` in the tenant's calendar (never
  an instant); omitted when unset. `imageUrl` omitted when none.
- Packaging: `unitsPerStrip`, `stripsPerCarton` (≥ 1). An item **supports**
  `individual` always, `strip` when `unitsPerStrip > 1`, `carton` when
  `unitsPerStrip > 1` and `stripsPerCarton > 1`.
  Base units: `strip = q × unitsPerStrip`, `carton = q × unitsPerStrip × stripsPerCarton`.

### InventoryMovement

```json
{
  "id": "mv_01J…",
  "itemId": "i2",
  "itemName": "باراسيتامول ٥٠٠ ملغ",
  "direction": "outflow",
  "quantity": 2,
  "packagingUnit": "strip",
  "convertedBaseUnitQuantity": 24,
  "reason": "صرف لمناوبة مركز الشعلان",
  "source": "mobile_app",
  "performedBy": "u_demo_main",
  "performedByName": "سلمى الحارثي",
  "stockBefore": 96,
  "stockAfter": 72,
  "at": "2026-09-28T07:41:12.000Z"
}
```

## 2. Create — `POST /inventory-items`

```http
POST /api/v1/inventory-items
Content-Type: application/json

{
  "detachmentId": "d_dam_central",
  "name": "شاش معقم",
  "unit": "علبة",
  "openingStock": 2,
  "openingUnit": "carton",
  "unitsPerStrip": 10,
  "stripsPerCarton": 5,
  "minimum": 30,
  "expiresOn": "2027-01-31"
}
```

→ `201` with `currentStock: 100` (2 cartons × 10 × 5), `preferredUnit:
"carton"` (defaults to `openingUnit`). Defaults: `openingStock 0`, `minimum
0`, `openingUnit individual`, packaging `1/1`.

When `openingStock > 0` the opening quantity is recorded as a real **inflow**
in the same transaction: `source: "inventory_setup"`, `reason: "رصيد افتتاحي"`,
`stockBefore: 0`, `stockAfter: <base units>` — the history starts where the
stock does.

| Refusal | When |
|---|---|
| `422 validation` | blank name/unit, negative `openingStock`/`minimum`, packaging ≤ 0, non-integer, `expiresOn` not `YYYY-MM-DD` |
| `422 packaging_required` | `openingUnit` (or `preferredUnit`) is `strip`/`carton` but the packaging does not define it |
| `404 not_found` | `detachmentId` not in the tenant |
| `403 not_permitted` | no `inventory.item.manage` in that detachment |

## 3. Edit — `PUT` / `PATCH /inventory-items/:itemId`

`PUT` = `{ id?, name, unit, minimum, unitsPerStrip?, stripsPerCarton?, preferredUnit?, expiresOn?, version? }`
— `name`, `unit`, `minimum` required; the rest absent = unchanged;
**`expiresOn: null` clears the expiry**. `PATCH` = any subset. The quantity
(`currentStock`) is **not editable** here and is ignored if sent; `level` is
recomputed (raising the minimum can turn an item `low`). A `preferredUnit`
the new packaging does not support → `422 packaging_required`. Stale
`version` → `409 stale_write` (a movement bumps `version` too).

## 4. Record a movement — `POST /inventory-items/:itemId/movements`

```http
POST /api/v1/inventory-items/i2/movements
Content-Type: application/json
Idempotency-Key: 01928c1e-…

{ "itemId": "i2", "direction": "outflow", "quantity": 2, "packagingUnit": "strip", "reason": "صرف لمناوبة مركز الشعلان" }
```

Body: `direction` (`inflow | outflow`), `quantity` (integer ≥ 1), `reason`
(≤ 280, default `""`), `packagingUnit` (default `individual`), `source`
(optional tag, default `mobile_app`), `itemId` (optional, must equal the path).
`performedBy` / `performedByName` are taken from the **session**, never the body.

Response `200` = the **updated** `InventoryItem` plus `lastMovement` (the
movement just recorded):

```json
{ "id": "i2", "currentStock": 72, "level": "low", "version": 8, "…": "…",
  "lastMovement": { "id": "mv_01J…", "direction": "outflow", "quantity": 2, "packagingUnit": "strip",
                    "convertedBaseUnitQuantity": 24, "stockBefore": 96, "stockAfter": 72, "…": "…" } }
```

**Race safety.** The stock change is ONE conditional atomic update — for an
outflow the filter is `currentStock ≥ amount` — that adds the signed amount,
bumps `version` and recomputes `level` from the new stock (aggregation-pipeline
update), inside a transaction with the movement insert and the change-log
entry. Two concurrent outflows can therefore never drive stock below zero:
the loser gets `insufficient_stock`.

| Refusal | When |
|---|---|
| `422 packaging_unavailable` | `packagingUnit` not supported by the item's packaging |
| `409 insufficient_stock` | outflow (in base units) larger than `currentStock` (`currentStock`, `requested`) |
| `422 validation` | quantity not an integer ≥ 1, unknown direction/unit, body `itemId` ≠ path |
| `403 not_permitted` | no `inventory.adjust` in the item's detachment |
| `404 not_found` | unknown / other-tenant item |

## 5. Delete — `DELETE /inventory-items/:itemId`

Removes the item, **all its movements** and its image (one transaction; the
file after commit) → `204`.

## 6. Image

`POST /inventory-items/:itemId/image` (multipart `image`) → re-encoded WebP
(800×800 inside), previous file removed; `DELETE …/image` clears it. Errors
as for any upload: `422 validation` (missing/unreadable), `413
payload_too_large`, `409 plan_limit_reached` (`storage_bytes`).
