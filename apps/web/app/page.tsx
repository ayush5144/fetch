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
  const [tableMenu, setTableMenu] = useState<{ table: Table; rect: DOMRect } | null>(null);

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
              <div key={t.id} className="card card-pad" style={{ position: 'relative' }}>
                <Link href={`/leads?table=${t.id}`} style={{ display: 'block', textDecoration: 'none' }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontSize: 18 }}>{t.icon ?? '▦'}</span>
                    <span className="cell-strong" style={{ fontSize: 15 }}>
                      {t.name}
                    </span>
                    {t.settings?.protected && (
                      <span className="pill" style={{ fontSize: 10, padding: '1px 7px', marginLeft: 'auto' }} title="Example table — protected">
                        Example
                      </span>
                    )}
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
                {/* Table actions — only shown for non-protected tables */}
                {!t.settings?.protected && (
                  <button
                    className="table-card-menu-btn"
                    title="Table options"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setTableMenu({ table: t, rect });
                    }}
                  >
                    ⋯
                  </button>
                )}
              </div>
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

      {/* Table card context menu */}
      {tableMenu && (
        <TableCardMenu
          table={tableMenu.table}
          anchorRect={tableMenu.rect}
          onClose={() => setTableMenu(null)}
          onDeleted={tables.refresh}
        />
      )}
    </>
  );
}

/** Small context menu for a table card (currently only Delete). */
function TableCardMenu({
  table,
  anchorRect,
  onClose,
  onDeleted,
}: {
  table: Table;
  anchorRect: DOMRect;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const top = Math.min(anchorRect.bottom + 4, window.innerHeight - 120);
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 200));
  const [busy, setBusy] = useState(false);

  async function deleteTable() {
    if (!confirm(`Delete table "${table.name}"? All leads and columns in this table will be permanently removed.`)) return;
    setBusy(true);
    try {
      await api.del(`/tables/${table.id}`);
      onDeleted();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="col-menu-backdrop" onClick={onClose} />
      <div className="col-menu" style={{ top, left }} role="menu">
        <button
          className="col-menu-item danger"
          disabled={busy}
          onClick={deleteTable}
        >
          <span>🗑</span> {busy ? 'Deleting…' : 'Delete table'}
        </button>
      </div>
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
