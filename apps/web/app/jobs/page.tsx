'use client';

import { useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { StatusPill } from '@/components/StatusPill';
import { api, type Job } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Job monitor — the observable projection of the queue. Live status, attempts,
 * and errors; a failed or dead job can be retried, which re-enqueues its stored
 * payload (idempotent handlers make that safe).
 */
export default function JobsPage() {
  const [status, setStatus] = useState('all');
  const path = status === 'all' ? '/jobs' : `/jobs?status=${status}`;
  const jobs = useApi<{ jobs: Job[] }>(path, 3000);
  const summary = useApi<{ summary: Record<string, number> }>('/jobs/summary', 3000);

  async function retry(id: string) {
    await api.post(`/jobs/${id}/retry`);
    setTimeout(jobs.refresh, 400);
  }

  const s = summary.data?.summary ?? {};
  const tiles = ['queued', 'active', 'completed', 'failed', 'dead'];

  return (
    <>
      <Topbar title="Job monitor" subtitle="Every slow operation is a retryable, observable job." />
      <div className="content stack">
        <div className="stat-grid">
          {tiles.map((t) => (
            <div className="stat" key={t}>
              <div className="stat-label">{t}</div>
              <div className="stat-value">{s[t] ?? 0}</div>
            </div>
          ))}
        </div>

        <div className="toolbar">
          {['all', 'queued', 'active', 'completed', 'failed', 'dead'].map((f) => (
            <button
              key={f}
              className={`btn btn-sm ${status === f ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStatus(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Lead</th>
                <th>Error</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data?.jobs ?? []).map((j) => (
                <tr key={j.id}>
                  <td className="cell-strong" style={{ textTransform: 'capitalize' }}>
                    {j.type}
                  </td>
                  <td>
                    <StatusPill status={j.status} />
                  </td>
                  <td>{j.attempts}</td>
                  <td className="cell-mono cell-muted">{j.leadId?.slice(0, 8) ?? '—'}</td>
                  <td className="cell-mono" style={{ color: 'var(--red)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {j.error ?? ''}
                  </td>
                  <td className="muted">{new Date(j.createdAt).toLocaleTimeString()}</td>
                  <td>
                    {(j.status === 'failed' || j.status === 'dead') && (
                      <button className="btn btn-ghost btn-sm" onClick={() => retry(j.id)}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(jobs.data?.jobs ?? []).length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      <div className="empty-icon">⚙</div>
                      No jobs to show.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
