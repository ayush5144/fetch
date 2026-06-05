import type { Campaign, EventType, Lead } from '@fetch/db';
import { getEnv, logger, RateLimiter } from '@fetch/core';
import { batch, type ParsedEvent, type PushResult, type SendAdapter } from './adapter';

/**
 * Process-wide limiter for Smartlead's documented cap of 10 requests / 2s.
 * Shared across every adapter instance so the whole worker stays under the
 * budget no matter how many sends run.
 */
const smartleadLimiter = new RateLimiter(10, 2_000);

/** Smartlead's event names → our internal vocabulary. */
const SMARTLEAD_EVENT_MAP: Record<string, EventType> = {
  EMAIL_SENT: 'sent',
  EMAIL_OPEN: 'opened',
  EMAIL_OPENED: 'opened',
  EMAIL_LINK_CLICK: 'clicked',
  EMAIL_CLICKED: 'clicked',
  EMAIL_REPLY: 'replied',
  EMAIL_REPLIED: 'replied',
  EMAIL_BOUNCE: 'bounced',
  EMAIL_BOUNCED: 'bounced',
  LEAD_UNSUBSCRIBED: 'unsubscribed',
};

/**
 * Smartlead adapter — the SECOND rail, proving the abstraction. It implements
 * the exact same SendAdapter interface as Instantly, so a campaign can switch
 * providers with no change to core or campaign code.
 *
 * Note: Smartlead's webhook payload is intentionally sparse (often just an email
 * + campaign id). That's a non-issue here because Fetch IS the lead store — we
 * match the event back to the local lead by email and already hold full context.
 */
export class SmartleadAdapter implements SendAdapter {
  readonly provider = 'smartlead' as const;
  private readonly apiKey = getEnv().SMARTLEAD_API_KEY;
  private static readonly BASE = 'https://server.smartlead.ai/api/v1';

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async push(leads: Lead[], campaign: Campaign): Promise<PushResult[]> {
    if (!this.available) {
      return leads.map((l) => ({ leadId: l.id, ok: false, error: 'smartlead not configured' }));
    }
    const results: PushResult[] = [];

    // Smartlead's add-to-campaign endpoint; chunk conservatively. The provider
    // rate limit (10 req / 2s) is respected by the worker's pacing.
    for (const chunk of batch(leads, 100)) {
      // Pace each request to respect the provider's 10 req / 2s limit.
      await smartleadLimiter.acquire();
      const url = `${SmartleadAdapter.BASE}/campaigns/${campaign.providerRef}/leads?api_key=${this.apiKey}`;
      const body = {
        lead_list: chunk.map((l) => ({
          email: l.email,
          first_name: l.firstName,
          last_name: l.lastName,
          custom_fields: { subject: l.subject ?? '', body: l.body ?? '', fetch_lead_id: l.id },
        })),
      };
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const error = `smartlead ${res.status}: ${await res.text()}`;
          for (const l of chunk) results.push({ leadId: l.id, ok: false, error });
          continue;
        }
        for (const l of chunk) results.push({ leadId: l.id, ok: true });
      } catch (err) {
        const error = `smartlead request failed: ${String(err)}`;
        logger.error(error);
        for (const l of chunk) results.push({ leadId: l.id, ok: false, error });
      }
    }
    return results;
  }

  parseEvent(payload: unknown): ParsedEvent | null {
    const p = payload as any;
    const rawType = String(p?.event_type ?? p?.webhook_event_type ?? '').toUpperCase();
    const type = SMARTLEAD_EVENT_MAP[rawType];
    if (!type) return null;
    return {
      type,
      providerEvt: String(p.event_id ?? p.id ?? `${rawType}:${p.to_email ?? p.email}:${p.time_sent ?? ''}`),
      email: p.to_email ?? p.lead_email ?? p.email ?? null,
      providerLeadId: p.lead_id ?? null,
      raw: payload,
    };
  }
}
