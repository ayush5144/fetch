# Known issues & fixes (running log)

> Status snapshot as of the 2026-06-06 deep review. Full test suite is **green**
> (217 unit + 343 db, typecheck + lint clean) — these are **behavioral/UX** issues,
> not failing code. "After `decc595`" = the R11 search-model + editable-plan work.

## Fixed (verified)

1. **JSON-mode 400 broke every Dogi/Bone run** *(post-decc595, biggest)*
   - The new default `gpt-4o-mini-search-preview` rejects `response_format:
     json_object` ("not supported with web_search"). We force JSON mode, so every
     run 400'd between R11a and the fix.
   - **Fix:** `openai.ts` omits `response_format` for `*-search-preview` models
     (like it already omits `temperature`); the prompt still asks for JSON and
     `parseResult` extracts it. Verified live (value + real source, no 400). Test
     added. *(committed: `bedb786`)*

2. **`[object Object]` cells** *(surfaced by the search model)*
   - The search model returns richer **structured** values (e.g. `contact_info =
     {email, phone, address}`). The data is REAL; the grid `String()`'d it.
   - **Fix:** `formatCellValue` renders objects as `k: v · k: v`, arrays joined by
     ` · `; strings/numbers unchanged. *(built, uncommitted/live in dev)*

3. **Button-added Dogi columns didn't auto-run**
   - `submitNewColumn` created + refreshed but never enqueued; backend
     `POST /columns` doesn't either. New Dogi columns sat empty.
   - **Fix:** a created **dogi** column with an instruction now auto-runs
     (run-only-if-empty, reuses `runColumn`). *(built, uncommitted/live)* — now
     gains a **Build-only opt-out**, see below.

## Open — being built (Round 12)

4. **✅ Append re-runs DUPLICATE rows** *(the big flag)*
   - Confirmed live (spas table: `Oceanic Spa` ×2, `The Nature Spa` ×2).
   - **Cause:** flow append calls `sourceRows(description, count)` — re-generates
     the **same** top-N list with no knowledge of existing rows — then
     `insertSourcedRows` runs with **no dedupe** (table policy defaults to `none`).
   - **Fix (decided):** when re-sourcing, **exclude existing primary-field values**
     (tell the model "give me NEW ones, not these") AND **dedupe new-vs-existing**
     on the primary field regardless of table policy; **skip** if no genuinely-new
     rows are found. Report how many were actually added.

5. **✅ Build only — Bone always runs on confirm**
   - Confirm both creates rows+columns AND enqueues every run (columns × rows =
     expensive).
   - **Fix (decided):** a **"Build and run"** toggle (default ON) beside the
     confirm; OFF = **Build only** (create the rows+columns automatically, but do
     NOT enqueue runs). Backend `/bone/run` takes a `run` flag.
   - Same for a **single added Dogi column**: a Build-only vs Build-and-run choice
     (frontend gates the auto-run).

6. **✅ Append sub-modes**
   - **Decided modes** on the run-flow modal:
     - **Replace** — re-run & overwrite existing cells (`force`).
     - **Append → Retry** — re-run **failed + empty** cells (run-only-if-empty),
       optionally add rows.
     - **Append → Only add new rows** — source N **new** (deduped) rows and run the
       flow **only on the new rows**; don't touch existing cells.

7. **✅ Running / queued state not always shown**
   - Sometimes a cell that's running/queued doesn't visibly show it. The cell
     state is derived from polled `/cell-jobs` + lead data; the indicator is
     unreliable.
   - **Fix:** make the running/queued display reliable — optimistic "queued" on
     run-trigger, robust job→cell mapping, ensure the poll covers the window, and
     the toolbar "working… N" + per-cell spinner stay in sync.

## Known / expected (not bugs)

- **Row shows "failed" when only *some* cells failed** — per-lead status = worst
  cell; the individual cells render correctly. May relabel "partial" later.
- **Hard-to-find fields** (e.g. a spa's owner name) → "No value found". Genuine;
  improving this is the "agent working" track (prefer OpenSERP+scrape, better
  prompts), planned separately.

## Later (noted)

- **Provider/lead-gen ingest (Apollo etc.)**: pulls feed the same `ingestLead`
  path, so the **per-table dedupe policy** governs them (merge on email/domain,
  fill-empty). A re-pull merges instead of duplicating — same principle as the
  append-dedupe in #4.

## Fixed — Vercel build (2026-06-06)

8. **✅ Vercel build failed on backend TS errors.** Vercel was running the **root
   `pnpm build`** (compiles the *whole* monorepo, incl. `apps/api` + `packages/*`),
   so it tried to `tsc`-build the backend and hit Drizzle `.d.ts`/overload errors
   that don't occur in a normal local build. But **`apps/web` is a pure HTTP
   client** — it imports **zero `@fetch/*` packages** (only next/react), so the
   deployed frontend never needs the backend compiled.
   - **Fix:** set the Vercel project **Root Directory = `apps/web`** (its package.json has `next`, so Vercel auto-detects Next.js and installs the pnpm workspace from the repo root). The backend (api/worker/mcp) runs elsewhere; it is not a Vercel target. (An earlier root `vercel.json` caused "No Next.js detected" because Root Directory was the monorepo root — removed.)
   - Note: the full monorepo DOES build clean locally from a clean state
     (`pnpm -r build`, dist gitignored, lockfile committed) — the failure was
     Vercel compiling code it shouldn't, not a real code bug.
