'use client';

import { Topbar } from '@/components/Topbar';
import { StatusPill } from '@/components/StatusPill';
import { type Lead } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Reply inbox — the return path made visible. Surfaces leads that came back
 * with a reply, bounce, or unsubscribe, read straight off the lead timestamps
 * the event handler stamps. This is what makes Fetch a learning loop, not a
 * one-way pipeline.
 */
export default function InboxPage() {
  const leads = useApi<{ leads: Lead[] }>('/leads', 5000);
  const events = (leads.data?.leads ?? []).filter((l) => l.repliedAt || l.bouncedAt);

  return (
    <>
      <Topbar title="Reply inbox" subtitle="Replies, bounces, and unsubscribes folded back in." />
      <div className="content">
        <div className="stack">
          {events.map((l) => (
            <div className="card card-pad row" key={l.id} style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="cell-strong">
                  {[l.firstName, l.lastName].filter(Boolean).join(' ') || l.email}
                </div>
                <div className="muted cell-mono" style={{ fontSize: 12 }}>
                  {l.email}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {l.repliedAt && <StatusPill status="replied" />}
                {l.bouncedAt && <StatusPill status="bounced" />}
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <div className="card">
              <div className="empty">
                <div className="empty-icon">✉</div>
                No replies or bounces yet. They'll appear here as provider webhooks arrive.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
