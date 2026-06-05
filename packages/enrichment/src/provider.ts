import type { Lead } from '@fetch/db';

/** A structured result from a provider: the value plus how to trust it. */
export interface ProviderResult {
  value: unknown;
  confidence: number; // 0..1
  source: string | null; // provenance URL or provider tag
}

/**
 * The Provider contract. A provider answers a single field for a single lead,
 * or returns null to signal a miss (the waterfall then tries the next one).
 * Each provider also declares its relative `cost` so the waterfall can order
 * cheapest-first, and whether it `supports` a field at all.
 */
export interface Provider {
  readonly name: string;
  /** Relative cost rank; lower runs first in the waterfall. */
  readonly cost: number;
  /** Whether this provider can answer the given field. */
  supports(field: string): boolean;
  /** Look the field up. Return null on a miss (not an error). */
  lookup(field: string, lead: Lead): Promise<ProviderResult | null>;
}

/** A provider is "available" only if its credentials are present. */
export interface ConfigurableProvider extends Provider {
  readonly available: boolean;
}
