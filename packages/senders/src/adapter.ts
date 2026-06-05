import type { Campaign, EventType, Lead } from '@fetch/db';

/**
 * The SendAdapter contract — the whole point of the adapter layer. Adding a new
 * send rail means implementing exactly these two methods; nothing above the
 * adapter changes. The core never learns a vendor's payload shape, batch size,
 * or webhook vocabulary — each adapter owns its own quirks.
 */

/** Result of pushing one lead to a provider. */
export interface PushResult {
  leadId: string;
  ok: boolean;
  providerLeadId?: string;
  error?: string;
}

/** A normalized event parsed from a provider webhook body. */
export interface ParsedEvent {
  /** Internal vocabulary — every provider's names collapse to these. */
  type: EventType;
  /** The provider's unique event id — our idempotency key. */
  providerEvt: string;
  /** How we match back to a local lead when the payload is sparse. */
  email?: string | null;
  providerLeadId?: string | null;
  raw: unknown;
}

export interface SendAdapter {
  readonly provider: 'instantly' | 'smartlead' | 'smtp';
  /** True when the adapter has the credentials it needs to actually send. */
  readonly available: boolean;
  /** Push approved + valid leads to the provider for this campaign. */
  push(leads: Lead[], campaign: Campaign): Promise<PushResult[]>;
  /** Normalize one inbound webhook body into our event vocabulary. */
  parseEvent(payload: unknown): ParsedEvent | null;
}

/** Split a list into batches of at most `size` — used to honor provider caps. */
export function batch<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
