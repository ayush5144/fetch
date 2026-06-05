'use client';

import Link from 'next/link';
import { Topbar } from '@/components/Topbar';
import { useApi } from '@/lib/useApi';

/** The overview: the funnel at a glance, read straight from /analytics/overview. */
interface Overview {
  leads: { total: number; valid: number; sent: number; replied: number; bounced: number };
  events: Record<string, number>;
}

export default function OverviewPage() {
  const { data } = useApi<Overview>('/analytics/overview', 8000);
  const l = data?.leads;

  const tiles = [
    { label: 'Total leads', value: l?.total ?? 0, foot: 'in the canonical store' },
    { label: 'Valid', value: l?.valid ?? 0, foot: 'passed the send gate' },
    { label: 'Sent', value: l?.sent ?? 0, foot: 'pushed to a provider' },
    { label: 'Replied', value: l?.replied ?? 0, foot: 'folded back from events' },
  ];

  return (
    <>
      <Topbar
        title="Overview"
        subtitle="One canonical record per lead, moving left to right through six operations."
        actions={
          <Link href="/leads" className="btn btn-accent">
            Open lead table
          </Link>
        }
      />
      <div className="content stack">
        <div className="stat-grid">
          {tiles.map((t) => (
            <div className="stat" key={t.label}>
              <div className="stat-label">{t.label}</div>
              <div className="stat-value">{t.value.toLocaleString()}</div>
              <div className="stat-foot">{t.foot}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>The loop</h3>
            <span className="pill pill-accent">
              <span className="dot" />
              ingest → enrich → validate → personalize → send → learn
            </span>
          </div>
          <div className="card-pad">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: 10,
                textAlign: 'center',
              }}
            >
              {[
                ['Ingest', 'CSV · API · manual'],
                ['Enrich', 'waterfall + agent'],
                ['Validate', 'syntax · MX · SMTP'],
                ['Personalize', 'draft + approve'],
                ['Send', 'Instantly · Smartlead'],
                ['Learn', 'events back in'],
              ].map(([title, sub], i) => (
                <div
                  key={title}
                  style={{
                    padding: '16px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    background: i % 2 ? 'var(--surface)' : 'var(--bg)',
                  }}
                >
                  <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 13 }}>{title}</div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {sub}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
