import { logger } from '@fetch/core';
import { getLLM, type GetLLMOptions } from '@fetch/llm';
import type { DogiSource } from './dogi';

/**
 * The goal-mode planner (Phase D). You describe an OUTCOME ("find the CEO's
 * email, then write a custom email"); Dogi decomposes it into an ordered list of
 * cell-Dogis — the columns it will create and fill, in dependency order.
 *
 * The planner is one LLM call that emits JSON only. We parse defensively and
 * return `null` when no LLM is configured (the caller degrades: no plan). The
 * plan is reviewed by a human before any column is created — this only proposes.
 */

/** Where a step's value lands. Goal mode always CREATES a new column. */
export interface DogiPlanOutput {
  mode: 'create';
  key: string;
  label?: string;
}

/** One planned column — a cell-Dogi plus its dependencies on earlier steps. */
export interface DogiPlanStep {
  /** Stable id within the plan (s1, s2, …). */
  id: string;
  /** Short human label for the column the step creates. */
  label: string;
  /** Plain-language task for this step. */
  instruction: string;
  /** Input columns the step may read (earlier step keys + base lead fields). */
  reads: string[];
  output: DogiPlanOutput;
  /** Sources this step may use; defaults to a single LLM transform. */
  sources: DogiSource[];
  /** combine (default) | first ("stop at first answer"). */
  policy: 'combine' | 'first';
  /** Keys of earlier steps' output columns this step reads (run-after). */
  dependsOn: string[];
}

export interface DogiPlan {
  goal: string;
  steps: DogiPlanStep[];
}

// ── Bone plan (row-sourcing + columns) ───────────────────────────────────────
// Bone is a superset of the column planner: a plan step is EITHER a row-sourcing
// step (CREATE rows) or a column step (today's DogiPlanStep — enrich rows). A
// step with NO `kind` is treated as `'column'`, so existing apply-plan/ask-dogi
// callers keep working unchanged. See devx/bone.md §3/§5.

/** A step that CREATES rows: generate `count` entities and insert them as leads. */
export interface SourceRowsStep {
  kind: 'source-rows';
  /** Plain-language description of the entities to create ("top 10 EV companies"). */
  description: string;
  /** Target number of entities (clamped to [1, 50] at run time). */
  count: number;
  /** The object key each generated entity carries (snake_case, e.g. "company"). */
  primaryField: string;
  /** Human label for that field's column. */
  primaryLabel: string;
}

/** A column step is today's DogiPlanStep, tagged with `kind: 'column'`. */
export type ColumnStep = { kind: 'column' } & DogiPlanStep;

/** One Bone plan step: create rows, or build/enrich a column. */
export type BonePlanStep = SourceRowsStep | ColumnStep;

export interface BonePlan {
  goal: string;
  steps: BonePlanStep[];
}

/** A step with no `kind` is a legacy column step (back-compat). */
export function isSourceRowsStep(step: { kind?: string }): step is SourceRowsStep {
  return step.kind === 'source-rows';
}

/** Normalize any plan step into a tagged column step (the back-compat default). */
export function asColumnStep(step: BonePlanStep | DogiPlanStep): ColumnStep {
  if ('kind' in step && step.kind === 'column') return step;
  // Strip a possible `kind` field, then re-tag as a column step.
  const { kind: _kind, ...rest } = step as ColumnStep;
  return { kind: 'column', ...(rest as DogiPlanStep) };
}

/** Context for a planning call — the table's existing columns + a BYOK key. */
export interface PlanContext {
  /** Existing column keys in the table, so the planner can read them. */
  existingColumns?: string[];
  /** Current number of rows in the table (0 → favor a leading source-rows step). */
  rowCount?: number;
  /** Brain selection for the planning call (provider/model). */
  brain?: { provider?: GetLLMOptions['provider']; model?: string; keySource?: 'env' | 'byok' };
  /** BYOK key for this call; never persisted or logged. */
  apiKey?: string;
}

const SYSTEM = `You are Bone's planner inside Fetch, a B2B lead workspace.
The user gives you a GOAL. You decompose it into an ordered list of "steps".
A step is EITHER:
  (A) a row-sourcing step that CREATES rows (entities) in the table, or
  (B) a column step that an agent fills for every row (enrichment).

Return ONLY a single JSON object, no prose, of this exact shape:
{
  "steps": [
    {
      "kind": "source-rows",
      "description": "the top 10 EV companies in the world",
      "count": 10,
      "primaryField": "company",
      "primaryLabel": "Company"
    },
    {
      "kind": "column",
      "id": "s1",
      "label": "CEO",
      "instruction": "Find the company's CEO's full name.",
      "reads": ["company"],
      "output": { "mode": "create", "key": "ceo", "label": "CEO" },
      "sources": [{ "type": "web", "via": "native" }, { "type": "llm" }],
      "policy": "combine",
      "dependsOn": []
    }
  ]
}

When to emit a row-sourcing step:
- If the goal asks to BUILD A LIST or FIND N entities ("top 10 companies",
  "the largest US banks", "list 20 SaaS startups"), emit ONE leading
  "source-rows" step that creates those entities, THEN column steps that enrich
  them. This is ESPECIALLY required when the table is currently empty — with no
  rows there is nothing for columns to fill.
- "count" is the number requested (default 10 if vague). "primaryField" is the
  snake_case key the created rows carry (usually "company" or "name"); the
  enrichment columns then read it.
- If the goal only enriches rows that already exist, emit NO source-rows step.

Column step rules:
- "kind" is "column". output.key is snake_case and unique within the plan.
- A column step that uses an earlier column's value (or the sourced primaryField)
  MUST list that key in BOTH "reads" and "dependsOn".
- "sources" is any of: { "type": "provider", "name": "<name>" },
  { "type": "web", "via": "native" | "external" }, { "type": "scrape", "via": "firecrawl" },
  { "type": "llm" }. A pure writing/transform step uses just [{ "type": "llm" }].
- "policy" is "combine" (default) or "first".
- Order steps so the row-sourcing step (if any) comes first, then dependencies.
Return the JSON object and nothing else.`;

/** The raw JSON we expect back; everything is validated/normalized below. */
interface RawStep {
  kind?: unknown;
  // source-rows fields
  description?: unknown;
  count?: unknown;
  primaryField?: unknown;
  primaryLabel?: unknown;
  // column fields
  id?: unknown;
  label?: unknown;
  instruction?: unknown;
  reads?: unknown;
  output?: { mode?: unknown; key?: unknown; label?: unknown };
  sources?: unknown;
  policy?: unknown;
  dependsOn?: unknown;
}

function snake(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Keep only well-formed sources; default to a single LLM transform. */
function normalizeSources(v: unknown): DogiSource[] {
  if (!Array.isArray(v)) return [{ type: 'llm' }];
  const out: DogiSource[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const t = (s as { type?: unknown }).type;
    if (t === 'provider' && typeof (s as { name?: unknown }).name === 'string') {
      out.push({ type: 'provider', name: (s as { name: string }).name });
    } else if (t === 'web' && ((s as { via?: unknown }).via === 'native' || (s as { via?: unknown }).via === 'external')) {
      out.push({ type: 'web', via: (s as { via: 'native' | 'external' }).via });
    } else if (t === 'scrape') {
      out.push({ type: 'scrape', via: 'firecrawl' });
    } else if (t === 'llm') {
      out.push({ type: 'llm' });
    }
  }
  return out.length ? out : [{ type: 'llm' }];
}

/** Turn one raw step into a normalized SourceRowsStep, or null when unusable. */
function normalizeSourceRows(raw: RawStep): SourceRowsStep | null {
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) return null;
  const rawCount = typeof raw.count === 'number' ? raw.count : Number(raw.count);
  const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 10;
  const primaryField =
    typeof raw.primaryField === 'string' && raw.primaryField.trim()
      ? snake(raw.primaryField)
      : 'company';
  const primaryLabel =
    typeof raw.primaryLabel === 'string' && raw.primaryLabel.trim()
      ? raw.primaryLabel.trim()
      : primaryField.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
  return { kind: 'source-rows', description, count, primaryField, primaryLabel };
}

/** Turn one raw step into a normalized DogiPlanStep, or null when unusable. */
function normalizeStep(raw: RawStep, index: number): DogiPlanStep | null {
  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';
  if (!instruction) return null;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `s${index + 1}`;
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : typeof raw.output?.label === 'string' && raw.output.label.trim()
        ? (raw.output.label as string).trim()
        : `Step ${index + 1}`;

  const key =
    typeof raw.output?.key === 'string' && raw.output.key.trim()
      ? snake(raw.output.key as string)
      : snake(label) || `step_${index + 1}`;

  const outLabel = typeof raw.output?.label === 'string' && raw.output.label.trim() ? (raw.output.label as string).trim() : label;

  const policy = raw.policy === 'first' ? 'first' : 'combine';

  return {
    id,
    label,
    instruction,
    reads: asStringArray(raw.reads),
    output: { mode: 'create', key, label: outLabel },
    sources: normalizeSources(raw.sources),
    policy,
    dependsOn: asStringArray(raw.dependsOn),
  };
}

/** Extract the single JSON object from the model's reply. */
function parsePlanJson(text: string): { steps?: unknown } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * The shared planner: one LLM call, then defensive normalization into a full
 * Bone plan (row-sourcing steps + column steps). Returns `null` when no LLM is
 * configured. Column output keys are snake_cased and made unique; the sourced
 * primaryField counts as a "known key" so a column may depend on it. `dependsOn`
 * is filtered to keys that actually exist among earlier steps + sourced fields,
 * so the dependency graph is always sound.
 */
async function runPlanner(goal: string, ctx: PlanContext): Promise<BonePlan | null> {
  const log = logger.child({ goal });

  const opts: GetLLMOptions = {};
  if (ctx.brain?.provider) opts.provider = ctx.brain.provider;
  if (ctx.brain?.model) opts.model = ctx.brain.model;
  if (ctx.brain?.keySource === 'byok' && ctx.apiKey) opts.apiKey = ctx.apiKey;

  const llm = getLLM(opts);
  if (!llm) {
    log.info('planner: no LLM configured');
    return null;
  }

  const parts: string[] = [];
  if (ctx.existingColumns?.length) {
    parts.push(`Existing columns the steps may read: ${ctx.existingColumns.join(', ')}.`);
  }
  if (ctx.rowCount != null) {
    parts.push(
      ctx.rowCount === 0
        ? 'The table is currently EMPTY (0 rows) — if the goal implies a list of entities, you MUST emit a leading source-rows step.'
        : `The table currently has ${ctx.rowCount} rows.`,
    );
  }
  const userContext = parts.length ? `\n\n${parts.join('\n')}` : '';

  const res = await llm.chat({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Goal: ${goal}${userContext}` },
    ],
    json: true,
    maxTokens: 1800,
  });

  const parsed = parsePlanJson(res.text);
  const rawSteps = Array.isArray(parsed?.steps) ? (parsed!.steps as RawStep[]) : [];

  // First pass: normalize each step in order, splitting into source-rows vs
  // column. A step with no `kind` is treated as a column (back-compat).
  const sourcedKeys = new Set<string>(); // primaryFields the sourcing steps create
  const usedKeys = new Set<string>();
  const steps: BonePlanStep[] = [];
  const columnSteps: ColumnStep[] = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i]!;
    if (raw.kind === 'source-rows') {
      const sr = normalizeSourceRows(raw);
      if (!sr) continue;
      sourcedKeys.add(sr.primaryField);
      steps.push(sr);
      continue;
    }
    const col = normalizeStep(raw, i);
    if (!col) continue;
    let key = col.output.key;
    let n = 1;
    while (usedKeys.has(key)) key = `${col.output.key}_${++n}`;
    usedKeys.add(key);
    col.output.key = key;
    const tagged: ColumnStep = { kind: 'column', ...col };
    steps.push(tagged);
    columnSteps.push(tagged);
  }

  // Resolve dependsOn against column output keys AND sourced primaryFields, then
  // make sure every dependency is also readable.
  const keyOf = new Map<string, string>(); // step id → output key
  for (const s of columnSteps) keyOf.set(s.id, s.output.key);
  const validKeys = new Set<string>([...columnSteps.map((s) => s.output.key), ...sourcedKeys]);
  for (const s of columnSteps) {
    s.dependsOn = [...new Set(s.dependsOn.map((d) => keyOf.get(d) ?? d).filter((k) => validKeys.has(k)))];
    for (const dep of s.dependsOn) {
      if (!s.reads.includes(dep)) s.reads.push(dep);
    }
  }

  log.info('planner produced a plan', { steps: steps.length, sourced: sourcedKeys.size });
  return { goal, steps };
}

/**
 * Plan a goal into the FULL Bone plan — ordered row-sourcing steps (create
 * rows) and column steps (enrich rows). This is what `/bone/plan` returns and
 * `/bone/run` executes. Returns `null` when no LLM is configured.
 */
export async function planBone(goal: string, ctx: PlanContext = {}): Promise<BonePlan | null> {
  return runPlanner(goal, ctx);
}

/**
 * Plan a goal into an ordered list of cell-Dogis (COLUMN steps only). This is
 * the back-compat surface for `ask-dogi`/`apply-plan`, which only build columns
 * over existing rows — any row-sourcing step the planner emits is dropped here.
 * Returns `null` when no LLM is configured.
 */
export async function planGoal(goal: string, ctx: PlanContext = {}): Promise<DogiPlan | null> {
  const plan = await runPlanner(goal, ctx);
  if (!plan) return null;
  const steps = plan.steps.filter((s): s is ColumnStep => !isSourceRowsStep(s));
  // Return bare DogiPlanStep shape (drop the `kind` tag) for back-compat.
  return {
    goal: plan.goal,
    steps: steps.map(({ kind: _kind, ...rest }) => rest),
  };
}
