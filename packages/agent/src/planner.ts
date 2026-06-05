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

/** Context for a planning call — the table's existing columns + a BYOK key. */
export interface PlanContext {
  /** Existing column keys in the table, so the planner can read them. */
  existingColumns?: string[];
  /** Brain selection for the planning call (provider/model). */
  brain?: { provider?: GetLLMOptions['provider']; model?: string; keySource?: 'env' | 'byok' };
  /** BYOK key for this call; never persisted or logged. */
  apiKey?: string;
}

const SYSTEM = `You are Dogi's planner inside Fetch, a B2B lead workspace.
The user gives you a GOAL. You decompose it into an ordered list of "steps",
each of which becomes ONE new column that an agent fills for every lead.

Return ONLY a single JSON object, no prose, of this exact shape:
{
  "steps": [
    {
      "id": "s1",
      "label": "CEO email",
      "instruction": "Find the company's CEO's email address.",
      "reads": ["company", "domain"],
      "output": { "mode": "create", "key": "ceo_email", "label": "CEO email" },
      "sources": [{ "type": "web", "via": "native" }, { "type": "llm" }],
      "policy": "combine",
      "dependsOn": []
    }
  ]
}

Rules:
- Each step's output.key is snake_case and unique within the plan.
- A step that uses an earlier step's value MUST (a) list that earlier step's
  output.key in "reads" AND (b) list that key in "dependsOn".
- "sources" is any of: { "type": "provider", "name": "<name>" },
  { "type": "web", "via": "native" | "external" }, { "type": "scrape", "via": "firecrawl" },
  { "type": "llm" }. A pure writing/transform step uses just [{ "type": "llm" }].
- "policy" is "combine" (default) or "first".
- Order steps so dependencies come first.
Return the JSON object and nothing else.`;

/** The raw JSON we expect back; everything is validated/normalized below. */
interface RawStep {
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
 * Plan a goal into an ordered list of cell-Dogis. Returns `null` when no LLM is
 * configured (the caller surfaces a "no LLM" reason). Output keys are normalized
 * to snake_case and made unique; `dependsOn` is filtered to keys that actually
 * exist among earlier steps, so the dependency graph is always sound.
 */
export async function planGoal(goal: string, ctx: PlanContext = {}): Promise<DogiPlan | null> {
  const log = logger.child({ goal });

  const opts: GetLLMOptions = {};
  if (ctx.brain?.provider) opts.provider = ctx.brain.provider;
  if (ctx.brain?.model) opts.model = ctx.brain.model;
  if (ctx.brain?.keySource === 'byok' && ctx.apiKey) opts.apiKey = ctx.apiKey;

  const llm = getLLM(opts);
  if (!llm) {
    log.info('planGoal: no LLM configured');
    return null;
  }

  const userContext = ctx.existingColumns?.length
    ? `\n\nExisting columns the steps may read: ${ctx.existingColumns.join(', ')}.`
    : '';

  const res = await llm.chat({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Goal: ${goal}${userContext}` },
    ],
    json: true,
    maxTokens: 1500,
  });

  const parsed = parsePlanJson(res.text);
  const rawSteps = Array.isArray(parsed?.steps) ? (parsed!.steps as RawStep[]) : [];

  // Normalize each step, then de-duplicate output keys across the plan.
  const usedKeys = new Set<string>();
  const steps: DogiPlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const step = normalizeStep(rawSteps[i]!, i);
    if (!step) continue;
    let key = step.output.key;
    let n = 1;
    while (usedKeys.has(key)) key = `${step.output.key}_${++n}`;
    usedKeys.add(key);
    step.output.key = key;
    steps.push(step);
  }

  // Keep only dependsOn entries that point at an earlier step's output key, and
  // make sure those keys are also in `reads` (a dependency you can't see is a bug).
  const keyOf = new Map<string, string>(); // step id → output key
  for (const s of steps) keyOf.set(s.id, s.output.key);
  const validKeys = new Set(steps.map((s) => s.output.key));
  for (const s of steps) {
    s.dependsOn = [...new Set(s.dependsOn.map((d) => keyOf.get(d) ?? d).filter((k) => validKeys.has(k)))];
    for (const dep of s.dependsOn) {
      if (!s.reads.includes(dep)) s.reads.push(dep);
    }
  }

  log.info('planGoal produced a plan', { steps: steps.length });
  return { goal, steps };
}
