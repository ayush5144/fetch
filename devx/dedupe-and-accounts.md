# Dedupe (optional) and the Accounts question

You're right to push on this. **Six people from Google are six valid leads** — we
should not silently merge them. This doc reframes dedupe as **optional and
user-chosen**, and demotes the Accounts section.

---

## 1. The problem with forced dedupe

Today ingestion **always** dedupes:
- leads by **email** (merge on match),
- accounts by **domain** (one company row per domain).

That's wrong as a default for a Clay-like tool. A user importing a list of people
at one company wants **all of them**, not one merged row. And "which field makes
two rows the same" is a **decision only the operator can make** — it's email for a
people list, domain for a company list, maybe nothing for a raw import.

---

## 2. New behavior: dedupe is a per-table choice

When creating/importing into a table, the operator picks a **dedupe policy**:

| Policy | Meaning |
|---|---|
| **None** (default for people) | Import every row; never merge. |
| **By column(s)** | Choose the key column(s) (e.g. `email`, or `domain`, or `linkedin_url`, or a composite). Rows matching merge; others create. |
| **By company** | The old behavior — one row per domain (for company tables). |

So dedupe becomes: *"how should this table decide two rows are the same?"* —
surfaced in the import/table-settings UI, defaulting to **None** for safety.

### Data/code impact
- `ingestLead` stops assuming email+domain; it takes a **dedupe policy** arg
  (`{ keys: string[] } | 'none'`).
- The `accounts` find-or-create becomes **opt-in** (only when a table's policy is
  "by company").
- Tables store their `dedupePolicy` in settings.

---

## 3. What happens to "Accounts"

**What it was for** (so it's clear): an *account* = the **company** behind a lead.
We deduped companies by domain and enriched each company **once** (size, industry,
tech, funding) so N people at Acme didn't each pay to research Acme. Useful, but
surfaced as a top-level nav item it just confused things.

**New stance:**
- **Demote** the standalone Accounts page (remove from the headline nav for now).
- Keep the **idea** as an *optional* capability: when a table uses "by company"
  dedupe (or you add a company-shared Dogi), company-level results can be cached
  and shared by domain — but it's **opt-in**, not a forced parallel entity.
- Later, if useful, "companies" is just **another table** (Clay's "All Companies"
  tab), linked to people via a relation column — not a special section.

Net: the operator decides if/how rows collapse, and company-sharing is a perf
optimization you switch on, not a structure forced on every import.

---

## 4. Migration / sequencing

- Backfill existing leads into the default table with policy **None** (no behavior
  change to stored data).
- Make `ingestLead`'s dedupe arg explicit; default callers to **None**.
- Gate `findOrCreateAccount` behind the "by company" policy.
- Drop Accounts from the sidebar; keep the table + API for when "companies as a
  table" lands.

This is mostly an **ingestion + settings** change; the canonical lead store and
everything downstream (validation, Dogi, sending) is unaffected.
