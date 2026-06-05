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

/** Compact "updated 3d ago" label; falls back to a date for older rows. */
function relativeUpdated(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
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
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Rows</th>
                  <th>Columns</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(tables.data?.tables ?? []).map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link
                        href={`/leads?table=${t.id}`}
                        className="row"
                        style={{ gap: 8, textDecoration: 'none' }}
                      >
                        <span style={{ fontSize: 16 }}>{t.icon ?? '▦'}</span>
                        <span className="cell-strong">{t.name}</span>
                        {t.settings?.protected && (
                          <span
                            className="pill pill-muted"
                            style={{ fontSize: 10, padding: '1px 7px' }}
                            title="Example table — protected"
                          >
                            Example
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="muted">{t.leadCount.toLocaleString()}</td>
                    <td className="muted">{t.columnCount}</td>
                    <td className="muted">{relativeUpdated(t.updatedAt ?? t.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!t.settings?.protected && (
                        <button
                          className="btn btn-ghost btn-sm"
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
                    </td>
                  </tr>
                ))}
                {(tables.data?.tables ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty">
                        <div className="empty-icon">▦</div>
                        No tables yet. Create one to start.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
