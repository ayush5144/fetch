import type { Lead } from '@fetch/db';
import { logger } from '@fetch/core';
import type { ConfigurableProvider, Provider, ProviderResult } from './provider';
import { ApolloProvider } from './providers/apollo';
import { HunterProvider } from './providers/hunter';

/**
 * The enrichment waterfall: providers are queried cheapest-first, and the
 * moment one returns a valid value the waterfall STOPS — you only pay for hits.
 * If every structured provider misses, the result is null and the caller falls
 * back to the agent loop.
 *
 * A per-(field, domain) cache lives for the lifetime of one run so that the
 * same company isn't looked up once per lead.
 */

export interface WaterfallResult extends ProviderResult {
  provider: string;
}

/** The data providers Fetch knows how to build, keyed by their Dogi name. */
const PROVIDER_REGISTRY: Record<string, () => Provider> = {
  apollo: () => new ApolloProvider(),
  hunter: () => new HunterProvider(),
};

/** Provider names Fetch can build (whether or not they have keys right now). */
export function knownProviders(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}

/**
 * Build a Waterfall over a SINGLE named data provider — the Dogi `provider`
 * source ("one data provider at a time for now"). Returns null when the name is
 * unknown OR the provider has no credentials, so the caller can skip the source
 * gracefully. Later we'll allow several ranked providers in one waterfall.
 */
export function singleProviderWaterfall(name: string): Waterfall | null {
  const make = PROVIDER_REGISTRY[name];
  if (!make) return null;
  const provider = make();
  if ('available' in provider && !(provider as ConfigurableProvider).available) return null;
  return new Waterfall([provider]);
}

export class Waterfall {
  private readonly providers: Provider[];
  private readonly cache = new Map<string, WaterfallResult | null>();

  constructor(providers?: Provider[]) {
    // Default registry, ordered by cost. Unavailable providers (no key) are
    // filtered out so the waterfall only calls what can actually answer.
    const registry = providers ?? [new ApolloProvider(), new HunterProvider()];
    this.providers = registry
      .filter((p) => !('available' in p) || (p as ConfigurableProvider).available)
      .sort((a, b) => a.cost - b.cost);
  }

  /** Which providers are actually live (have credentials) right now. */
  get activeProviders(): string[] {
    return this.providers.map((p) => p.name);
  }

  private cacheKey(field: string, lead: Lead): string {
    const domain = lead.email?.split('@')[1] ?? lead.accountId ?? lead.id;
    return `${field}::${domain}`;
  }

  /**
   * Run the waterfall for one field on one lead. Returns the first hit (with
   * provider + provenance) or null if the structured sources are exhausted.
   */
  async run(field: string, lead: Lead): Promise<WaterfallResult | null> {
    const key = this.cacheKey(field, lead);
    if (this.cache.has(key)) {
      logger.debug('waterfall cache hit', { field, key });
      return this.cache.get(key)!;
    }

    for (const provider of this.providers) {
      if (!provider.supports(field)) continue;
      try {
        const hit = await provider.lookup(field, lead);
        if (hit && hit.value !== null && hit.value !== '') {
          const result: WaterfallResult = { ...hit, provider: provider.name };
          this.cache.set(key, result); // STOP — first hit wins.
          return result;
        }
      } catch (err) {
        // A provider failure is a miss, not a fatal — try the next rung.
        logger.warn('provider failed, continuing waterfall', {
          provider: provider.name,
          field,
          err: String(err),
        });
      }
    }

    this.cache.set(key, null); // structured sources exhausted
    return null;
  }
}
