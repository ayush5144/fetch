# The leads grid — Google Sheets / Clay feel

The leads view should feel like a spreadsheet you **operate**, not a report you
read. This is the screen we perfect first. Reference: the Clay screenshot
(`+ Add column` at the right edge, per-cell `Run cell`, status dots, row numbers).

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
  popover** anchored where the column will appear, to name it, pick type
  (**Dogi** / formula / manual / text), and set config. (Not a center modal.)
- **Header `⋯` menu** per column: Run column · Edit (reopen config) · Rename ·
  Duplicate · Insert left/right · Sort · Filter · **Delete**.
- **Header `▷ Run`** on enrichable columns: fan out the Dogi over visible/selected
  rows (respects run-only-if-empty unless "force").
- Column **type icon** (🔍 Dogi, ƒ formula, ✎ manual, T text) for quick scanning.
- Drag to reorder / resize (nice-to-have, after the basics).

### Cells
- **Empty enrichable cell** → shows **`▷ Run`** on hover ("Run cell").
- **States**: `empty → queued → running (spinner/%) → filled → error`. Filled
  shows value + **confidence dot** + a **source** link; error shows the reason +
  retry.
- **Inline edit** for manual/text cells (type to set; Enter to save).
- Click a filled cell → a **side peek** with the full value, provenance URL,
  which Dogi/model produced it, and "Re-run".

### Rows
- **Select** (checkbox) → bulk actions: run a column over the selection, delete,
  move to another table.
- **Row number** column on the left.
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
| Cell render | `UserCell` (run / value+conf) | add state machine: queued/running/error + side peek |
| Column header | plain `<th>` | name + `▷` + `⋯` menu + type icon |
| Rows | list only | row numbers, checkboxes, inline `+ new lead`, inline edit |
| Data source | `GET /leads` (global) | `GET /tables/:id/leads` (per table — see multi-table) |

Keep the design tokens in `apps/web/app/globals.css` (navy ink + coral accent);
the grid stays on-brand and consistent.
