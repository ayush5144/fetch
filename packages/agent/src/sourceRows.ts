import { logger } from '@fetch/core';
import { getLLM, type GetLLMOptions } from '@fetch/llm';
import type { DogiBrain } from './dogi';

/**
 * Row-sourcing — Doggo's headline new power (devx/doggo.md §2). The existing
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

const SYSTEM = `You are Doggo's row-sourcing agent inside Fetch, a B2B workspace.
The user describes a LIST of real-world entities to create (e.g. "top 10 EV
companies", "the largest US banks"). Produce that list.

Return ONLY a single JSON ARRAY and nothing else — no prose, no code fences.
Each element is an object whose keys are EXACTLY the requested field name(s),
with one entity per object. Example for fields ["company"] and "top 3 EV makers":
[{"company":"Tesla"},{"company":"BYD"},{"company":"Rivian"}]

Rules:
- Return at most the requested count; fewer is fine if you cannot name that many.
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

/**
 * Generate up to `count` entity rows from a description. Returns `{ rows: [] }`
 * (never throws) when no LLM is configured or the reply doesn't parse. Each row
 * is a plain object keyed by `fields` (default `['company']`); non-object or
 * empty elements are dropped, and the result is capped at the clamped count.
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

  let text = '';
  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Create ${count} entities for: ${input.description}\nFields per entity: ${JSON.stringify(
            fields,
          )}`,
        },
      ],
      // NOTE: no `json: true`. Several providers' JSON mode forces a top-level
      // OBJECT, but we want a top-level ARRAY. The system prompt already demands
      // a bare array, and `parseRowsJson` extracts it defensively either way.
      maxTokens: 2000,
    });
    text = res.text;
  } catch (err) {
    log.warn('sourceRows: LLM call failed', { err: String(err) });
    return { rows: [], provider: `${llm.provider}:${llm.model}` };
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
    if (rows.length >= count) break;
  }

  log.info('sourceRows produced rows', { produced: rows.length });
  return { rows, provider: `${llm.provider}:${llm.model}` };
}
