import type { Lead } from '@fetch/db';
import { getEnv } from '@fetch/core';
import type { ConfigurableProvider, ProviderResult } from '../provider';

/**
 * Apollo provider. People/company enrichment. Cheapest tier in our default
 * waterfall, so cost = 1. Only "available" when APOLLO_API_KEY is set; the
 * waterfall skips unavailable providers.
 *
 * The lookup hits Apollo's people match endpoint and pulls common fields. Each
 * provider isolates its own request shape so the waterfall stays vendor-neutral.
 */
export class ApolloProvider implements ConfigurableProvider {
  readonly name = 'apollo';
  readonly cost = 1;

  private readonly apiKey = getEnv().APOLLO_API_KEY;
  get available(): boolean {
    return Boolean(this.apiKey);
  }

  /** Fields Apollo can answer in this MVP slice. */
  private static FIELDS = new Set([
    'title',
    'company_size',
    'industry',
    'company_name',
    'linkedin_url',
  ]);

  supports(field: string): boolean {
    return ApolloProvider.FIELDS.has(field);
  }

  async lookup(field: string, lead: Lead): Promise<ProviderResult | null> {
    if (!this.available || !lead.email) return null;

    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey! },
      body: JSON.stringify({ email: lead.email }),
    });
    if (!res.ok) return null;

    const person = ((await res.json()) as any)?.person;
    if (!person) return null;

    const value = pickField(field, person);
    if (value === null || value === undefined) return null;

    return {
      value,
      confidence: 0.85,
      source: person.linkedin_url ?? 'https://apollo.io',
    };
  }
}

function pickField(field: string, person: any): unknown {
  switch (field) {
    case 'title':
      return person.title ?? null;
    case 'company_size':
      return person.organization?.estimated_num_employees ?? null;
    case 'industry':
      return person.organization?.industry ?? null;
    case 'company_name':
      return person.organization?.name ?? null;
    case 'linkedin_url':
      return person.linkedin_url ?? null;
    default:
      return null;
  }
}
