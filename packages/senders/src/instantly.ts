import type { Campaign, EventType, Lead } from '@fetch/db';
import { getEnv, logger } from '@fetch/core';
import { batch, type ParsedEvent, type PushResult, type SendAdapter } from './adapter';

/** Instantly's event names → our internal vocabulary. */
const INSTANTLY_EVENT_MAP: Record<string, EventType> = {
  email_sent: 'sent',
  email_opened: 'opened',
  email_open: 'opened',
  email_link_clicked: 'clicked',
  email_link_click: 'clicked',
  reply_received: 'replied',
  email_reply: 'replied',
  email_bounced: 'bounced',
  lead_unsubscribed: 'unsubscribed',
};

/**
 * Instantly adapter — the first send rail. Maps Fetch leads to Instantly's
 * `POST /api/v2/leads`, batches in chunks of ≤1000, and passes the
 * skip-duplicate / verify-on-import flags. All Instantly-specific shape lives
 * here and nowhere else.
 */
export class InstantlyAdapter implements SendAdapter {
  readonly provider = 'instantly' as const;
  private readonly apiKey = getEnv().INSTANTLY_API_KEY;

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async push(leads: Lead[], campaign: Campaign): Promise<PushResult[]> {
    if (!this.available) {
      return leads.map((l) => ({ leadId: l.id, ok: false, error: 'instantly not configured' }));
    }
    const results: PushResult[] = [];

    // Instantly accepts up to 1000 leads per request.
    for (const chunk of batch(leads, 1000)) {
      const payload = {
        campaign: campaign.providerRef,
        skip_if_in_workspace: true,
        verify_leads_on_import: true,
        leads: chunk.map((l) => ({
          email: l.email,
          first_name: l.firstName,
          last_name: l.lastName,
          company_name: (l.data as any)?.company_name ?? null,
          personalization: l.body,
          custom_variables: { subject: l.subject, fetch_lead_id: l.id },
        })),
      };

      try {
        const res = await fetch('https://api.instantly.ai/api/v2/leads', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const error = `instantly ${res.status}: ${await res.text()}`;
          for (const l of chunk) results.push({ leadId: l.id, ok: false, error });
          continue;
        }
        const data = (await res.json()) as any;
        // Instantly returns created lead ids; match back by email where possible.
        const byEmail = new Map<string, string>(
          (data.leads ?? []).map((d: any) => [String(d.email).toLowerCase(), d.id]),
        );
        for (const l of chunk) {
          results.push({
            leadId: l.id,
            ok: true,
            providerLeadId: byEmail.get((l.email ?? '').toLowerCase()),
          });
        }
      } catch (err) {
        const error = `instantly request failed: ${String(err)}`;
        logger.error(error);
        for (const l of chunk) results.push({ leadId: l.id, ok: false, error });
      }
    }
    return results;
  }

  parseEvent(payload: unknown): ParsedEvent | null {
    const p = payload as any;
    const rawType = String(p?.event_type ?? p?.event ?? '').toLowerCase();
    const type = INSTANTLY_EVENT_MAP[rawType];
    if (!type) return null;
    return {
      type,
      providerEvt: String(p.id ?? p.event_id ?? `${rawType}:${p.email}:${p.timestamp}`),
      email: p.lead_email ?? p.email ?? null,
      providerLeadId: p.lead_id ?? null,
      raw: payload,
    };
  }
}
