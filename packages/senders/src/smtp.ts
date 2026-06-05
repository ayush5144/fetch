import type { Campaign, Lead } from '@fetch/db';
import { getEnv, logger } from '@fetch/core';
import type { ParsedEvent, PushResult, SendAdapter } from './adapter';

/**
 * Generic SMTP adapter — the fallback rail with no third-party platform. It
 * proves the interface bottoms out at raw mail: implement push() over SMTP and
 * the rest of Fetch is unchanged.
 *
 * To keep the baseline dependency-light, actual SMTP transport (nodemailer) is
 * wired in lazily and only when SMTP_HOST is configured; otherwise the adapter
 * reports unavailable like any other unconfigured rail. SMTP has no inbound
 * webhook vocabulary, so parseEvent always returns null.
 */
export class SmtpAdapter implements SendAdapter {
  readonly provider = 'smtp' as const;
  private readonly env = getEnv();

  get available(): boolean {
    return Boolean(this.env.SMTP_HOST && this.env.SMTP_FROM);
  }

  async push(leads: Lead[], _campaign: Campaign): Promise<PushResult[]> {
    if (!this.available) {
      return leads.map((l) => ({ leadId: l.id, ok: false, error: 'smtp not configured' }));
    }
    // Lazy import so nodemailer is only required when SMTP is actually used.
    let transport: any;
    try {
      const nodemailer = await import('nodemailer');
      transport = nodemailer.createTransport({
        host: this.env.SMTP_HOST,
        port: this.env.SMTP_PORT,
        secure: this.env.SMTP_PORT === 465,
        auth: this.env.SMTP_USER ? { user: this.env.SMTP_USER, pass: this.env.SMTP_PASS } : undefined,
      });
    } catch (err) {
      const error = `smtp transport unavailable (install nodemailer): ${String(err)}`;
      return leads.map((l) => ({ leadId: l.id, ok: false, error }));
    }

    const results: PushResult[] = [];
    for (const lead of leads) {
      if (!lead.email) {
        results.push({ leadId: lead.id, ok: false, error: 'no email' });
        continue;
      }
      try {
        const info = await transport.sendMail({
          from: this.env.SMTP_FROM,
          to: lead.email,
          subject: lead.subject ?? '',
          text: lead.body ?? '',
        });
        results.push({ leadId: lead.id, ok: true, providerLeadId: info.messageId });
      } catch (err) {
        logger.error('smtp send failed', { lead_id: lead.id, err: String(err) });
        results.push({ leadId: lead.id, ok: false, error: String(err) });
      }
    }
    return results;
  }

  parseEvent(_payload: unknown): ParsedEvent | null {
    return null; // raw SMTP has no inbound event channel
  }
}
