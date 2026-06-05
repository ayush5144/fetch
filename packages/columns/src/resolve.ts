import { runAgent, runDogi, type DogiConfig } from '@fetch/agent';
import type { Column, Lead } from '@fetch/db';
import { getLLM } from '@fetch/llm';
import { Waterfall } from '@fetch/enrichment';
import { logger } from '@fetch/core';
import { evaluateFormula, type FormulaConfig } from './formula';

/**
 * Resolve one cell's value according to its column TYPE. This is the heart of
 * the dynamic column engine — a column is a definition of *how a value gets
 * filled*, and this function executes that definition:
 *
 *   dogi       → run the configurable Dogi (providers · web · scrape · LLM)
 *   formula    → derive from other columns (no network, no cost)
 *   manual     → never resolved here; a human types it (no job)
 *   enrichment → (legacy) provider waterfall, then the agent loop as a fallback
 *   agent      → (legacy) the LLM tool-loop directly, driven by the prompt
 */

export interface ResolvedCell {
  value: unknown;
  confidence: number;
  source: string | null;
  provider: string;
}

/** Per-run context threaded through resolution (e.g. a BYOK key). */
export interface ResolveContext {
  /** BYOK key for this run; never persisted or logged. */
  apiKey?: string;
}

/**
 * The output key a column writes to. A Dogi whose `config.output.mode === 'map'`
 * (or 'create') points at a specific key; otherwise the cell IS its column.
 */
export function outputKeyOf(column: Column): string {
  const config = (column.config as Record<string, any>) ?? {};
  return config.output?.key ?? column.key;
}

export async function resolveCell(
  lead: Lead,
  column: Column,
  ctx?: ResolveContext,
): Promise<ResolvedCell | null> {
  const config = (column.config as Record<string, any>) ?? {};
  const log = logger.child({ lead_id: lead.id, column: column.key });

  switch (column.type) {
    case 'dogi': {
      const dogiConfig: DogiConfig = {
        instruction: config.instruction ?? '',
        reads: config.reads,
        sources: config.sources,
        policy: config.policy,
        brain: config.brain,
        maxSteps: config.maxSteps,
      };
      const res = await runDogi(dogiConfig, {
        field: outputKeyOf(column),
        lead,
        apiKey: ctx?.apiKey,
      });
      if (!res) return null;
      return { value: res.value, confidence: res.confidence, source: res.source, provider: res.provider };
    }

    case 'enrichment': {
      const field = config.field ?? column.key;
      const wf = new Waterfall();
      const hit = await wf.run(field, lead);
      if (hit) {
        return { value: hit.value, confidence: hit.confidence, source: hit.source, provider: hit.provider };
      }
      // Waterfall missed → fall back to the agent loop when an LLM is available.
      if (getLLM()) {
        log.info('waterfall miss, falling back to agent');
        const res = await runAgent({ field, lead, prompt: config.prompt });
        if (!res.exhausted) {
          return { value: res.value, confidence: res.confidence, source: res.source, provider: 'agent' };
        }
      }
      return null;
    }

    case 'agent': {
      if (!getLLM()) {
        log.warn('agent column skipped: no LLM configured');
        return null;
      }
      const res = await runAgent({
        field: config.outputField ?? column.key,
        prompt: config.prompt,
        lead,
        maxSteps: config.maxSteps,
      });
      if (res.exhausted) return null;
      return { value: res.value, confidence: res.confidence, source: res.source, provider: 'agent' };
    }

    case 'formula': {
      const value = evaluateFormula(config as FormulaConfig, lead);
      if (value === null) return null;
      // Formula values are derived and certain, with no external source.
      return { value, confidence: 1, source: null, provider: 'formula' };
    }

    case 'manual':
    default:
      return null; // human-entered; nothing to resolve
  }
}
