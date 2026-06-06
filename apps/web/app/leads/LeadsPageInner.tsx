'use client';

import { useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { LeadsGrid } from '@/components/leads/LeadsGrid';
import { useApi } from '@/lib/useApi';
import { Modal } from '@/components/Modal';
import { api, tablesApi, type Lead, type Column, type CellJob, type Table } from '@/lib/api';

const DEFAULT_TABLE = 'tbl_default_leads';

/**
 * The leads view — a Clay-style spreadsheet grid scoped to a single table.
 * The table is picked from the URL ?table=<id>, defaulting to tbl_default_leads.
 *
 * Data flows:
 * - GET /tables/:id/leads  → rows (polled every 4 s)
 * - GET /tables/:id/columns → column definitions (polled every 8 s)
 * - GET /tables/:id/cell-jobs → live cell job states (polled every 3 s)
 *
 * The heading shows the table's actual name (resolved from the tables list,
 * since there's no single GET /tables/:id), with a small ⋯ menu for rename +
 * delete. All cell mutations go through LeadsGrid.
 */
export default function LeadsPageInner() {
  const params = useSearchParams();
  const tableId = params.get('table') ?? DEFAULT_TABLE;

  const leadsApi = useApi<{ leads: Lead[] }>(`/tables/${tableId}/leads`, 4000);
  const columnsApi = useApi<{ columns: Column[] }>(`/tables/${tableId}/columns`, 8000);
  const jobsApi = useApi<{ jobs: CellJob[] }>(`/tables/${tableId}/cell-jobs`, 3000);
  // Reuse the list endpoint to resolve this table's name/protected flag — there
  // is no single GET /tables/:id route.
  const tablesListApi = useApi<{ tables: Table[] }>('/tables', 8000);

  const leads = leadsApi.data?.leads ?? [];
  const columns = columnsApi.data?.columns ?? [];
  const jobs = jobsApi.data?.jobs ?? [];

  const table = (tablesListApi.data?.tables ?? []).find((t) => t.id === tableId);
  const tableName = table?.name ?? 'Leads';
  const isProtected = Boolean(table?.settings?.protected);

  const [menu, setMenu] = useState<DOMRect | null>(null);

  const isLoading = leadsApi.loading && columnsApi.loading;

  return (
    <div className="grid-page">
      <Topbar
        title={tableName}
        subtitle={
          leadsApi.loading
            ? 'Loading…'
            : `${leads.length} lead${leads.length !== 1 ? 's' : ''}`
        }
        actions={
          table && !isProtected ? (
            <button
              className="btn btn-ghost btn-sm"
              title="Table options"
              onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
            >
              ⋯
            </button>
          ) : undefined
        }
      />

      {menu && table && (
        <TableHeadingMenu
          table={table}
          anchorRect={menu}
          onClose={() => setMenu(null)}
          onRenamed={tablesListApi.refresh}
        />
      )}

      {isLoading ? (
        <div className="content muted" style={{ padding: 48, textAlign: 'center' }}>
          Loading table…
        </div>
      ) : leadsApi.error ? (
        <div className="content" style={{ padding: 48, textAlign: 'center', color: 'var(--red)' }}>
          {leadsApi.error}
        </div>
      ) : (
        <LeadsGrid
          tableId={tableId}
          table={table}
          leads={leads}
          columns={columns}
          jobs={jobs}
          onRefreshLeads={leadsApi.refresh}
          onRefreshColumns={columnsApi.refresh}
          onRefreshTable={tablesListApi.refresh}
        />
      )}
    </div>
  );
}

/** Rename (inline) / Delete menu by the table heading. Mirrors the Overview's
 *  TableCardMenu; delete navigates back to the Overview. Hidden for protected
 *  tables (the caller doesn't render the ⋯ trigger for them). */
function TableHeadingMenu({
  table,
  anchorRect,
  onClose,
  onRenamed,
}: {
  table: Table;
  anchorRect: DOMRect;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const router = useRouter();
  const top = Math.min(anchorRect.bottom + 4, window.innerHeight - 200);
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 240));
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState(table.name);
  const [error, setError] = useState<string | null>(null);

  async function commitRename() {
    const next = name.trim();
    if (!next || next === table.name) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      await tablesApi.rename(table.id, next);
      onRenamed();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
      setBusy(false);
    }
  }

  async function deleteTable() {
    if (!confirm(`Delete table "${table.name}"? All leads and columns in this table will be permanently removed.`)) return;
    setBusy(true);
    try {
      await api.del(`/tables/${table.id}`);
      router.push('/');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="col-menu-backdrop" onClick={onClose} />
      <div className="col-menu" style={{ top, left }} role="menu">
        {renaming ? (
          <div style={{ padding: 10, minWidth: 220 }}>
            <input
              className="input"
              autoFocus
              value={name}
              disabled={busy}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') onClose();
              }}
              aria-label="Table name"
            />
            {error && (
              <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>Cancel</button>
              <button
                className="btn btn-accent btn-sm"
                disabled={busy || !name.trim()}
                onClick={commitRename}
              >
                {busy ? 'Saving…' : 'Rename'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button className="col-menu-item" onClick={() => { setName(table.name); setError(null); setRenaming(true); }}>
              <span>Aa</span> Rename table
            </button>
            <button className="col-menu-item" onClick={() => setSettingsOpen(true)}>
              <span>⚙</span> Table settings
            </button>
            <div className="col-menu-sep" />
            <button className="col-menu-item danger" disabled={busy} onClick={deleteTable}>
              <span>🗑</span> {busy ? 'Deleting…' : 'Delete table'}
            </button>
          </>
        )}
      </div>
      {settingsOpen && (
        <TableSettingsModal
          table={table}
          onClose={() => setSettingsOpen(false)}
          onSaved={onRenamed}
        />
      )}
    </>
  );
}

/**
 * Per-table settings modal. Today it carries a single agent-column toggle; the
 * layout leaves room for future settings (e.g. dedupe). The toggle persists via
 * `PATCH /tables/:id { settings: { agentColumn } }`, which the API shallow-merges
 * into the table's existing settings.
 */
function TableSettingsModal({
  table,
  onClose,
  onSaved,
}: {
  table: Table;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [agentColumn, setAgentColumn] = useState(Boolean(table.settings?.agentColumn));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleAgentColumn(next: boolean) {
    setAgentColumn(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/tables/${table.id}`, { settings: { agentColumn: next } });
      onSaved();
    } catch (e) {
      setAgentColumn(!next); // revert on failure
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Table settings" maxWidth={420} onClose={onClose}>
      <div className="table-settings-row">
        <label className="bone-toggle" style={{ alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={agentColumn}
            disabled={busy}
            onChange={(e) => toggleAgentColumn(e.target.checked)}
          />
          <span>
            <span className="table-settings-label">Show a flow agent column</span>
            <span className="table-settings-help">
              Adds a compact control in the grid toolbar for each Bone flow so you
              can re-run the whole flow with one click.
            </span>
          </span>
        </label>
      </div>
      {error && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>
      )}
    </Modal>
  );
}
