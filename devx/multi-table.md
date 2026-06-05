# Multi-table — a workspace of tables

Clay organizes work into a **workbook of tables** (the tabs at the bottom of the
screenshot: `clay table 1 non enriched`, `clay 1 enriched`, `All Companies`…).
We adopt the same: a workspace holds **many tables**, each with its **own columns
and rows**, created and opened from the **Overview**.

---

## 1. Concept

- A **table** is a named grid (e.g. "India tech companies", "Enriched", "All
  people"). It owns its columns and its leads.
- **Overview** is the launcher: list tables, **+ New table**, **+ New lead** (into
  a chosen table), recent activity.
- Selecting a table opens the **leads grid** ([leads-grid.md](./leads-grid.md))
  scoped to that table.

A lead still belongs to one canonical store, but is **scoped to a table** so the
grid you operate is always one table's rows + columns.

---

## 2. Data model change

Today `leads` and `columns` are global. We add a `tables` table and a `table_id`
scope.

```
tables ──────────────────────────────────────────
  id          cuid    PK
  name        string
  description string?
  icon        string?          ← optional emoji/icon for the tab
  created_at  datetime
  updated_at  datetime

leads
  + table_id  cuid  FK → tables.id   (which table this row lives in)

columns
  + table_id  cuid  FK → tables.id   (columns are per-table now)
  // key stays unique PER TABLE, not globally
```

Notes:
- `columns.key` uniqueness moves from global → **unique per `(table_id, key)`**.
- Existing single-table data migrates into a default "Leads" table (one row in
  `tables`, backfill `table_id` on all leads/columns).
- Jobs/events/audit already reference `lead_id`, so they're unaffected.

## 3. Migration sketch

1. Create `tables`; insert a default table "Leads".
2. Add nullable `table_id` to `leads` and `columns`; backfill to the default
   table; then set `NOT NULL`.
3. Swap the `columns.key` unique index for a composite `(table_id, key)`.
4. New rows always carry `table_id`.

(One Drizzle migration; reversible; no data loss.)

## 4. API surface

| Now | After |
|---|---|
| `GET /leads` | `GET /tables/:id/leads` |
| `POST /leads`, `/leads/import` | same, but require `table_id` |
| `GET /columns`, `POST /columns` | `GET /tables/:id/columns`, `POST /tables/:id/columns` |
| — | `GET /tables`, `POST /tables`, `PATCH/DELETE /tables/:id` |

Run-column/run-cell endpoints stay the same (they act on `lead_id` + `columnKey`).

## 5. Overview redesign

```
Overview
┌──────────────────────────────────────────────────────────┐
│  Tables                                   [ + New table ] │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ Leads        │ │ Enriched     │ │ All companies│       │
│  │ 1,240 rows   │ │ 312 rows     │ │ 88 rows      │       │
│  │ 6 columns    │ │ 14 columns   │ │ 5 columns    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                            │
│  Quick add a lead → [ table ▼ ] [ + New lead ]            │
└──────────────────────────────────────────────────────────┘
```

A table tab strip can also live at the bottom of the grid (Clay-style) for fast
switching once you're in a table.

## 6. Relationship to dedupe

Dedupe is now decided **per table** and is optional (see
[dedupe-and-accounts.md](./dedupe-and-accounts.md)). One table might dedupe people
by email; another (a company list) might dedupe by domain; another might allow
duplicates entirely.
