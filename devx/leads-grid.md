# The leads grid — Google Sheets / Clay feel

The leads view should feel like a spreadsheet you **operate**, not a report you
read. This is the screen we perfect first. Reference: the Clay screenshot
(`+ Add column` at the right edge, per-cell `Run cell`, status dots, row numbers).

**Design north star: built for non-technical users.** Anyone — not just an
engineer — should be able to make a table, add a column, edit a cell, and run a
Dogi without docs. Friendly type names, inline help, no jargon, familiar
spreadsheet gestures (click-to-edit, drag-to-reorder, drag-to-resize).

---

## 1. Anatomy

```
┌────┬───────────────────┬────────────────────┬─────────────────────┬───────┐
│ ☐  │ Company        ⋯ │ CEO email      ▷ ⋯ │ Recent signal  ▷ ⋯ │  +    │  ← header: name, run ▷, menu ⋯, trailing +Add
├────┼───────────────────┼────────────────────┼─────────────────────┼───────┤
│ ☐  │ %  up to date     │      <1%            │      40%            │       │  ← optional "column health" row
├────┼───────────────────┼────────────────────┼─────────────────────┼───────┤
│ 1  │ Acme              │ ● ava@acme.com  ◔92%│ ◷ running…         │       │  ← cell states + confidence
│ 2  │ Globex            │ ▷ Run              │ ▷ Run               │       │  ← empty cell → hover Run
│ 3  │ Initech           │ ⚠ missing inputs   │ ● Series B  ◔80%   │       │
├────┴───────────────────┴────────────────────┴─────────────────────┴───────┤
│ + new lead                                                                 │  ← inline add-row
└────────────────────────────────────────────────────────────────────────────┘
```

Left: select checkboxes + row numbers. Right edge: a **permanent `+`** column.
Bottom: **`+ new lead`**.

---

## 2. Features (what makes it Clay-like)

### Columns
- **Trailing `+ Add column`** header cell, always present. Click → an **inline
  popover** anchored where the column will appear, to name it, pick a **type**
  (see §2.1), and set config. (Not a center modal.)
- **Names are unique** within a table — creating/renaming to an existing name is
  rejected inline with a clear message (no two columns share a name or key).
- **Header `⋯` menu** per column: Run column · Edit (reopen config) · Rename ·
  Duplicate · Insert left/right · Sort · Filter · **Delete**.
- **Header `▷ Run`** on Dogi columns: fan out over visible/selected rows
  (respects run-only-if-empty unless "force").
- Column **type icon** for quick scanning.
- **Drag to resize** a column (persisted width) and **drag to reorder** columns
  (move column 3 between 1 and 2 — persisted order). This is a **core** table
  behavior, not a nice-to-have.

#### 2.1 Column types — a friendly picker
A column has a **value type** and (for filled columns) a **fill method**. The
create popover shows one simple list; we don't make a new user learn jargon:

| Value type | Holds / validates | Icon |
|---|---|---|
| **Text** | any text | T |
| **Email** | a valid email | ✉ |
| **URL** | a link | 🔗 |
| **Number** | numeric, sortable | # |
| **Date** | a date | 📅 |
| **Select** | one of a fixed set | ▾ |
| **Checkbox** | true/false | ☑ |

| Fill method | How the cell fills |
|---|---|
| **Manual** | a person types it (typed by the value type above) |
| **Dogi (AI)** | the agent fills it ([dogi-agent.md](./dogi-agent.md)) |
| **Formula** | derived from other columns |

Type **validates on edit** (an Email column rejects `not-an-email`; a Number
column stores numbers). The set is extensible — more value types later.

### Cells
- **Empty Dogi cell** → shows **`▷ Run`** on hover ("Run cell").
- **States**: `empty → queued → running (spinner/%) → filled → error`. Filled
  shows value + **confidence dot** + a **source** link; error shows the reason +
  retry.
- **Inline edit ANY field** — click any row×column cell to edit it in place
  (Enter saves, Esc cancels), with **type validation**. Editing a **computed**
  cell (Dogi/formula) **overrides** it and marks it "edited" (Clay-style), so a
  human can always correct a value.
- Click a filled cell → a **side peek** with the full value, provenance URL,
  which Dogi/model produced it, and "Re-run".

### Rows
- **Select** (checkbox) → bulk actions: run a column over the selection, delete,
  move to another table.
- **Row number** column on the left (the **index**; the checkbox + index columns
  are structural, always present — no preset *content* columns).
- **A new table starts with one blank row** showing `1` in the index — so a fresh
  table is never a dead end ("no rows yet"). The user types into it, or **Bone**
  fills/creates rows (see [bone.md](./bone.md)).
- **Drag to reorder rows** (persisted order).
- **`+ new lead`** at the bottom adds a blank row inline; fill cells directly.

### Toolbar (top of grid)
- Search, filter, sort, and a **Run** control (run a column / all empty / a view).
- A small **run status** ("1% of table complete", like Clay) when a batch is live.

---

## 3. Cell state machine

```
        add column / new lead
                │
                ▼
            ┌────────┐  run-cell / run-column   ┌────────┐
            │ empty  │ ───────────────────────► │ queued │
            └────────┘                          └───┬────┘
                ▲                                    │ worker claims
                │ clear                              ▼
            ┌────────┐      success            ┌─────────┐
            │ error  │ ◄───────────────────────│ running │
            └────────┘      failure            └────┬────┘
                                                    │ success
                                                    ▼
                                               ┌────────┐
                                               │ filled │  value + confidence + source
                                               └────────┘
```

State is derived from the lead row + the live `jobs` rows for that cell (we
already mirror jobs). The grid **polls** today (4s); fine to start, tighten later.

---

## 4. What changes in code

| Piece | Today | Change |
|---|---|---|
| `apps/web/app/leads/page.tsx` | basic table, top-bar buttons | rebuild as the grid above |
| Add-column | `components/leads/AddColumnModal.tsx` (modal) | inline **popover** at the `+` header (can reuse the form) |
| Cell render | `UserCell` (run / value+conf) | state machine (queued/running/error) + **inline edit any field** + type validation + side peek |
| Column header | plain `<th>` | name + `▷` + `⋯` menu + type icon; **drag-reorder + drag-resize** |
| Column types | 4 fill types | add **value types** (text/email/url/number/date/select/checkbox) + validation; enforce **unique names** |
| Rows | list only | row numbers, checkboxes, inline `+ new lead`, **drag-reorder rows** |
| Data source | `GET /leads` (global) | `GET /tables/:id/leads` (per table — see multi-table) |

For drag/resize/reorder we'll likely use a small, headless table/dnd library
(e.g. TanStack Table + a dnd kit) rather than hand-rolling — keeps it robust and
accessible. Decide the exact lib at build time.

Keep the design tokens in `apps/web/app/globals.css` (navy ink + coral accent);
the grid stays on-brand and consistent.

---

## 5. Import mapping, spacing & the example table (Phase B.1)

- **Import CSV with column mapping.** Choosing a file shows its headers; the
  operator maps each header to an **existing column** or **creates a new** one
  (with a value type). A **blank table auto-creates** every header as a new
  column. Known identity headers (name/email/company) still map to system fields.
- **Spacing.** Cells and rows carry comfortable padding — not corner-to-corner —
  so the grid reads cleanly. (Tune the `.grid-cell` / `.grid-tbl` tokens.)
- **The "Fetch table" example.** Overview seeds one example table named **Fetch
  table** that is **protected**: it cannot be deleted, and its **fixed columns
  cannot be deleted** (delete returns 403; the UI hides those actions).
  Protection applies ONLY to this example table — every other table and column
  behaves normally (add, edit, run, delete). Protection is flagged via
  `tables.settings.protected` and `columns.config.protected`.
