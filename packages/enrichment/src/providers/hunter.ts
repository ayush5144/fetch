import type { Lead } from '@fetch/db';
import { getEnv } from '@fetch/core';
import type { ConfigurableProvider, ProviderResult } from '../provider';

/**
 * Hunter provider — strong for email discovery and company/domain data. Sits
 * after Apollo in the waterfall (cost = 2). Demonstrates the second rung: when
 * Apollo misses, Hunter is tried before the agent loop ever runs.
 */
export class HunterProvider implements ConfigurableProvider {
  readonly name = 'hunter';
  readonly cost = 2;

  private readonly apiKey = getEnv().HUNTER_API_KEY;
  get available(): boolean {
    return Boolean(this.apiKey);
  }

  private static FIELDS = new Set(['email', 'company_name', 'industry']);

  supports(field: string): boolean {
    return HunterProvider.FIELDS.has(field);
  }

  async lookup(field: string, lead: Lead): Promise<ProviderResult | null> {
    if (!this.available) return null;
    const domain = lead.email?.split('@')[1];
    if (!domain) return null;

    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(
      domain,
    )}&api_key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = ((await res.json()) as any)?.data;
    if (!data) return null;

    const value =
      field === 'company_name'
        ? data.organization
        : field === 'industry'
          ? data.industry
          : (data.emails?.[0]?.value ?? null);
    if (!value) return null;

    return { value, confidence: 0.75, source: `https://${domain}` };
  }
}
