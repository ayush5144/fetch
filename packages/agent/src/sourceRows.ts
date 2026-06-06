import { logger } from '@fetch/core';
import { getLLM, type GetLLMOptions } from '@fetch/llm';
import type { DogiBrain } from './dogi';

/**
 * Row-sourcing — Bone's headline new power (devx/bone.md §2). The existing
 * planner + Dogi can only ENRICH rows that already exist; nobody could CREATE
 * them. `sourceRows` is that missing verb: given a description ("top 10 EV
 * companies") and a count, it asks an LLM for a JSON ARRAY of entities, each an
 * object keyed by the requested field(s). The caller then inserts those objects
 * as leads (via the core ingest helper), so the table gets its rows before the
 * enrichment columns run.
 *
 * This is a GENERATION task, not a never-guess research lookup — so it uses a
 * transform-style system prompt (produce values), mirroring `SYSTEM_TRANSFORM`
 * in dogi.ts. It makes ONE LLM call, parses defensively, and NEVER throws:
 * a parse failure or missing brain returns `{ rows: [], provider }`.
 */

/** Hard ceiling on how many rows one sourcing call may create. */
export const MAX_SOURCE_ROWS = 50;

export interface SourceRowsInput {
  /** Plain-language description of the entities to create ("top 10 EV companies"). */
  description: string;
  /** Target number of entities; clamped to [1, MAX_SOURCE_ROWS]. */
  count: number;
  /** The object key(s) each generated entity should carry. Defaults to ['company']. */
  fields?: string[];
  /** Brain selection (provider/model + keySource) for the generation call. */
  brain?: DogiBrain;
  /** BYOK key for this call; never persisted or logged. */
  apiKey?: string;
}

export interface SourceRowsResult {
  rows: Array<Record<string, unknown>>;
  /** Provenance tag — the provider:model that generated the rows, or 'none'. */
  provider: string;
}

const SYSTEM = `You are Bone's row-sourcing agent inside Fetch, a B2B workspace.
The user describes a LIST of real-world entities to create (e.g. "top 10 EV
companies", "the largest US banks"). Produce that list.

Return ONLY a single JSON ARRAY and nothing else — no prose, no code fences.
Each element is an object whose keys are EXACTLY the requested field name(s),
with one entity per object. Example for fields ["company"] and "top 3 EV makers":
[{"company":"Tesla"},{"company":"BYD"},{"company":"Rivian"}]

Rules:
- Return EXACTLY the requested count of entities when you can; fewer ONLY if you
  genuinely cannot name that many real ones. Do not pad with fakes.
- Return DISTINCT, REAL-WORLD organizations/entities of the requested type — the
  kind that has a single identifiable head (e.g. one CEO). For "AI companies":
  OpenAI, Anthropic, Nvidia, Google/Alphabet, Microsoft — the actual companies.
- DO NOT return divisions, product lines, sub-brands, or features as if they were
  companies (NOT "Google AI", "Salesforce Einstein", "IBM Watson", "Microsoft
  AI", "AWS"). Prefer the PARENT company (Alphabet/Google, not "Google AI").
- No duplicates and no two entries that are the same organization under different
  names (e.g. Google and Alphabet are ONE — pick one).
- Use real, well-known entities; do not invent fake names.
- Every object uses the SAME requested key(s). No extra keys, no nesting.
Return the JSON array and nothing else.`;

/** Clamp the requested count into the allowed range. */
function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(MAX_SOURCE_ROWS, Math.floor(count)));
}

/** Extract the first JSON array from the model's reply, or null. */
function parseRowsJson(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Minimal shape of the LLM handle we use (so the parse helper stays untyped). */
type LLMHandle = NonNullable<ReturnType<typeof getLLM>>;

/** A normalized dedupe key for one row — the lowercased values of its fields. */
function rowKey(row: Record<string, unknown>, fields: string[]): string {
  return fields.map((f) => String(row[f] ?? '').trim().toLowerCase()).join('|');
}

/**
 * Make ONE generation call and return the cleaned rows (objects keyed by the
 * requested fields, empties dropped). Never throws — an LLM error or unparseable
 * reply yields `[]`. `extra` carries an optional "you already returned these,
 * give me N MORE distinct ones" instruction for the single re-prompt.
 */
async function generateOnce(
  llm: LLMHandle,
  description: string,
  fields: string[],
  want: number,
  extra?: string,
  log?: ReturnType<typeof logger.child>,
): Promise<Array<Record<string, unknown>>> {
  let text = '';
  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Create ${want} entities for: ${description}\nFields per entity: ${JSON.stringify(
            fields,
          )}${extra ? `\n${extra}` : ''}`,
        },
      ],
      // NOTE: no `json: true`. Several providers' JSON mode forces a top-level
      // OBJECT, but we want a top-level ARRAY. The system prompt already demands
      // a bare array, and `parseRowsJson` extracts it defensively either way.
      maxTokens: 2000,
    });
    text = res.text;
  } catch (err) {
    log?.warn('sourceRows: LLM call failed', { err: String(err) });
    return [];
  }

  const raw = parseRowsJson(text) ?? [];
  const rows: Array<Record<string, unknown>> = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const obj = el as Record<string, unknown>;
    // Keep only the requested fields; require at least one non-empty value.
    const row: Record<string, unknown> = {};
    let hasValue = false;
    for (const f of fields) {
      const v = obj[f];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        row[f] = v;
        hasValue = true;
      }
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

/**
 * Generate EXACTLY `count` entity rows from a description (count clamped to
 * [1, MAX_SOURCE_ROWS]). Returns `{ rows: [] }` (never throws) when no LLM is
 * configured or the first reply doesn't parse. Each row is a plain object keyed
 * by `fields` (default `['company']`); non-object/empty elements are dropped.
 *
 * Exactness contract (R1.3): if the model returns MORE than `count`, the result
 * is trimmed to `count`. If it returns FEWER, ONE re-prompt asks for just the
 * remainder (de-duplicated against what we already have) and stops — no looping.
 * If still short, the actual (shorter) array is returned so the caller can report
 * the shortfall.
 */
export async function sourceRows(input: SourceRowsInput): Promise<SourceRowsResult> {
  const count = clampCount(input.count);
  const fields = input.fields?.length ? input.fields : ['company'];
  const log = logger.child({ description: input.description, count });

  const opts: GetLLMOptions = {};
  if (input.brain?.provider) opts.provider = input.brain.provider;
  if (input.brain?.model) opts.model = input.brain.model;
  if (input.brain?.keySource === 'byok' && input.apiKey) opts.apiKey = input.apiKey;

  const llm = getLLM(opts);
  if (!llm) {
    log.info('sourceRows: no LLM configured');
    return { rows: [], provider: 'none' };
  }
  const provider = `${llm.provider}:${llm.model}`;

  // First pass: ask for the full count, dedupe within the batch.
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  const add = (batch: Array<Record<string, unknown>>): void => {
    for (const row of batch) {
      if (rows.length >= count) break;
      const k = rowKey(row, fields);
      if (k === '' || seen.has(k)) continue;
      seen.add(k);
      rows.push(row);
    }
  };

  add(await generateOnce(llm, input.description, fields, count, undefined, log));

  // Exactly ONE re-prompt for the remainder when short (no infinite loop).
  if (rows.length < count) {
    const remaining = count - rows.length;
    const had = rows.map((r) => fields.map((f) => String(r[f] ?? '')).join(' / ')).join('; ');
    const extra = `You already returned these — do NOT repeat them: ${had}.\nReturn ${remaining} MORE distinct entities of the same kind, as a JSON array.`;
    add(await generateOnce(llm, input.description, fields, remaining, extra, log));
  }

  log.info('sourceRows produced rows', { produced: rows.length, requested: count });
  return { rows, provider };
}
