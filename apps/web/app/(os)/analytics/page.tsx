'use client';

import { Topbar } from '@/components/Topbar';
import { useApi } from '@/lib/useApi';

interface Overview {
  leads: { total: number; valid: number; sent: number; replied: number; bounced: number };
  events: Record<string, number>;
}

/**
 * Analytics — the funnel, derived directly from the events table so the numbers
 * always agree with the source of truth. The bars read sent → opened → clicked
 * → replied as a share of sent.
 */
export default function AnalyticsPage() {
  const { data } = useApi<Overview>('/analytics/overview', 8000);
  const e = data?.events ?? {};
  const sent = e.sent ?? 0;
  const pct = (n: number) => (sent > 0 ? Math.round((n / sent) * 100) : 0);

  const funnel = [
    { label: 'Sent', n: e.sent ?? 0, pct: 100 },
    { label: 'Opened', n: e.opened ?? 0, pct: pct(e.opened ?? 0) },
    { label: 'Clicked', n: e.clicked ?? 0, pct: pct(e.clicked ?? 0) },
    { label: 'Replied', n: e.replied ?? 0, pct: pct(e.replied ?? 0) },
    { label: 'Bounced', n: e.bounced ?? 0, pct: pct(e.bounced ?? 0) },
  ];

  return (
    <>
      <Topbar title="Analytics" subtitle="Deliverability and engagement, straight from events." />
      <div className="content stack">
        <div className="stat-grid">
          <Stat label="Total leads" value={data?.leads.total ?? 0} />
          <Stat label="Valid" value={data?.leads.valid ?? 0} />
          <Stat label="Sent" value={data?.leads.sent ?? 0} />
          <Stat label="Replied" value={data?.leads.replied ?? 0} />
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Engagement funnel</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              as a share of sent
            </span>
          </div>
          <div className="card-pad stack" style={{ gap: 18 }}>
            {funnel.map((f) => (
              <div key={f.label}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="cell-strong">{f.label}</span>
                  <span className="muted">
                    {f.n.toLocaleString()} · {f.pct}%
                  </span>
                </div>
                <div className="bar">
                  <span
                    style={{
                      width: `${f.pct}%`,
                      background: f.label === 'Bounced' ? 'var(--red)' : 'var(--accent)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value.toLocaleString()}</div>
    </div>
  );
}
