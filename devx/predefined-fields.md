# Predefined common fields (on top of arbitrary columns)

> Status: **PLANNING → building.** A thin convenience layer over the
> arbitrary-columns model — it adds **recognition + icons** for a handful of
> ubiquitous fields. It does NOT reintroduce a fixed schema.

## The principle (unchanged)

A Fetch table is **arbitrary columns** — any column key/label/type the user (or
Bone) wants. Values live in `leads.data[key]`. We did NOT add fixed identity
columns back; see [multi-table.md](./multi-table.md) and the Round-5 work.

## What this adds

Some fields are so common in B2B tables that they deserve to be **recognized**:

| Field (key) | Value type | Icon |
|---|---|---|
| `name` / `first_name` / `last_name` | text | 👤 |
| `email` | email | ✉ |
| `phone` | text | ☎ |
| `title` | text | 🏷 |
| `linkedin_url` | url | 🔗 |
| **`company`** | text | **🏢** |

Recognition shows up in **two** places, both purely cosmetic/convenience:

1. **Add-column quick-pick** ("Common fields") — picking *Company* pre-fills
   `key: company`, `label: Company`, the right value type, and now its icon. The
   user can still type any custom column instead — nothing is forced.
2. **Grid column icon** — a column whose **key** matches a predefined field shows
   that field's icon (so `company` shows 🏢, not the generic `T`). Resolution
   order: **predefined-field-by-key → value-type icon → column-type icon → `T`**.

## Why `company` specifically

`company` was already a quick-pick template but rendered as a plain `T` because
icons were keyed only on *value type* (and company is just `text`). Company is the
single most common anchor in a B2B table (and the field Bone sources rows into),
so it earns a recognizable sign like `email` has — **without** becoming a fixed
schema column. It stays an arbitrary `data.company` key.

## What this is NOT

- **Not** a new canonical/fixed column. The leads table schema is unchanged.
- **Not** special enrichment behavior. (`company` is already surfaced to Dogi via
  `leadContext` from Round 5; nothing new there.)
- **Not** mandatory. Custom columns of any name/type work exactly as before.

## Implementation note

Keep a **single shared registry** of predefined fields (`{ key, label,
valueType, icon }`) so the add-column chips and the grid `columnIcon` agree —
one source of truth, no drift. Adding/removing a recognized field is a one-line
registry edit.

Related: [leads-grid.md](./leads-grid.md) (column types + icons),
[multi-table.md](./multi-table.md) (arbitrary columns), [bone.md](./bone.md)
(Bone sources rows into the `company` column).
