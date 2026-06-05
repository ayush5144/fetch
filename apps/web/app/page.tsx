'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { Modal } from '@/components/Modal';
import { api, type Table } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Overview — the table launcher (Phase A). Lists every table with its row/column
 * counts and creates new ones. This is where an operator picks which table to
 * work in, Clay-style.
 */
interface Overview {
  leads: { total: number; valid: number; sent: number; replied: number };
}

export default function OverviewPage() {
  const tables = useApi<{ tables: Table[] }>('/tables', 6000);
  const stats = useApi<Overview>('/analytics/overview', 8000);
  const [open, setOpen] = useState(false);

  const l = stats.data?.leads;
  const tiles = [
    { label: 'Total leads', value: l?.total ?? 0 },
    { label: 'Valid', value: l?.valid ?? 0 },
    { label: 'Sent', value: l?.sent ?? 0 },
    { label: 'Replied', value: l?.replied ?? 0 },
  ];

  return (
    <>
      <Topbar
        title="Overview"
        subtitle="Your tables — pick one to work in, or start a new one."
        actions={
          <button className="btn btn-accent" onClick={() => setOpen(true)}>
            New table
          </button>
        }
      />
      <div className="content stack">
        <div className="stat-grid">
          {tiles.map((t) => (
            <div className="stat" key={t.label}>
              <div className="stat-label">{t.label}</div>
              <div className="stat-value">{t.value.toLocaleString()}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="section-title">Tables</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {(tables.data?.tables ?? []).map((t) => (
              <Link key={t.id} href={`/leads?table=${t.id}`} className="card card-pad" style={{ cursor: 'pointer' }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{t.icon ?? '▦'}</span>
                  <span className="cell-strong" style={{ fontSize: 15 }}>
                    {t.name}
                  </span>
                </div>
                {t.description && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {t.description}
                  </div>
                )}
                <div className="row" style={{ gap: 14, marginTop: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t.leadCount.toLocaleString()} rows
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t.columnCount} columns
                  </span>
                </div>
              </Link>
            ))}
            {(tables.data?.tables ?? []).length === 0 && (
              <div className="card">
                <div className="empty">
                  <div className="empty-icon">▦</div>
                  No tables yet. Create one to start.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {open && <NewTableModal onClose={() => setOpen(false)} onDone={tables.refresh} />}
    </>
  );
}

function NewTableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit() {
    setBusy(true);
    try {
      const { table } = await api.post<{ table: Table }>('/tables', { name, description });
      onDone();
      onClose();
      router.push(`/leads?table=${table.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New table"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !name} onClick={submit}>
            {busy ? 'Creating…' : 'Create table'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input
          className="input"
          placeholder="e.g. India tech companies"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label>Description (optional)</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}
