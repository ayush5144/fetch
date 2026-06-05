import { runAgent } from '@fetch/agent';
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
 *   enrichment → provider waterfall, then the agent loop as a fallback
 *   agent      → the LLM tool-loop directly, driven by the column's prompt
 *   formula    → derive from other columns (no network, no cost)
 *   manual     → never resolved here; a human types it (no job)
 */

export interface ResolvedCell {
  value: unknown;
  confidence: number;
  source: string | null;
  provider: string;
}

export async function resolveCell(
  lead: Lead,
  column: Column,
  waterfall?: Waterfall,
): Promise<ResolvedCell | null> {
  const config = (column.config as Record<string, any>) ?? {};
  const log = logger.child({ lead_id: lead.id, column: column.key });

  switch (column.type) {
    case 'enrichment': {
      const field = config.field ?? column.key;
      const wf = waterfall ?? new Waterfall();
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
