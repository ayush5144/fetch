'use client';

import { useMemo, useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { StatusPill } from '@/components/StatusPill';
import { AddColumnModal } from '@/components/leads/AddColumnModal';
import { AddLeadModal } from '@/components/leads/AddLeadModal';
import { ImportModal } from '@/components/leads/ImportModal';
import { api, type Column, type Lead } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * The lead table — the operator's home. System columns gate behavior
 * (validation, approval, send); user columns are filled by running their job.
 *
 * Per-cell run, run-column, inline edit, filter, and live polling all live here.
 * Every action posts to the API, which writes a row + enqueues a job; the table
 * polls and the results appear in place — the canonical-record-as-a-table idea.
 */
export default function LeadsPage() {
  const leads = useApi<{ leads: Lead[] }>('/leads', 4000);
  const columns = useApi<{ columns: Column[] }>('/columns');
  const [modal, setModal] = useState<null | 'import' | 'addLead' | 'addColumn'>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');

  const userColumns = columns.data?.columns ?? [];

  const rows = useMemo(() => {
    let list = leads.data?.leads ?? [];
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((l) =>
        [l.firstName, l.lastName, l.email, l.title].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    if (filter !== 'all') list = list.filter((l) => l.validationStatus === filter);
    return list;
  }, [leads.data, query, filter]);

  async function runCell(leadId: string, key: string) {
    await api.post(`/leads/${leadId}/run/${key}`);
    setTimeout(leads.refresh, 600);
  }

  async function runColumn(key: string) {
    await api.post(`/columns/${key}/run`, { leadIds: rows.map((r) => r.id) });
    setTimeout(leads.refresh, 600);
  }

  return (
    <>
      <Topbar
        title="Leads"
        subtitle={`${rows.length} of ${leads.data?.leads.length ?? 0} leads`}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setModal('addColumn')}>
              + Column
            </button>
            <button className="btn btn-ghost" onClick={() => setModal('addLead')}>
              + Lead
            </button>
            <button className="btn btn-accent" onClick={() => setModal('import')}>
              Import CSV
            </button>
          </>
        }
      />

      <div className="content">
        <div className="toolbar">
          <div className="search">
            <span className="muted">⌕</span>
            <input
              placeholder="Search name, email, title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select className="select" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All validation</option>
            <option value="valid">Valid</option>
            <option value="risky">Risky</option>
            <option value="invalid">Invalid</option>
            <option value="unchecked">Unchecked</option>
            <option value="no_email">No email</option>
          </select>
          <div className="spacer" />
          {userColumns
            .filter((c) => c.type !== 'manual')
            .map((c) => (
              <button key={c.id} className="btn btn-ghost btn-sm" onClick={() => runColumn(c.key)}>
                ▷ Run {c.label}
              </button>
            ))}
        </div>

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Email</th>
                <th>Validation</th>
                {userColumns.map((c) => (
                  <th key={c.id}>{c.label}</th>
                ))}
                <th>Approval</th>
                <th>Send</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((lead) => (
                <tr key={lead.id}>
                  <td className="cell-strong">
                    {[lead.firstName, lead.lastName].filter(Boolean).join(' ') || (
                      <span className="cell-muted">—</span>
                    )}
                    {lead.title && (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {lead.title}
                      </div>
                    )}
                  </td>
                  <td className="cell-mono">{lead.email ?? <span className="cell-muted">no email</span>}</td>
                  <td>
                    <StatusPill status={lead.validationStatus} />
                  </td>
                  {userColumns.map((c) => (
                    <UserCell key={c.id} lead={lead} column={c} onRun={() => runCell(lead.id, c.key)} />
                  ))}
                  <td>
                    <StatusPill status={lead.approvalStatus} />
                  </td>
                  <td>
                    <StatusPill status={lead.sendStatus} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5 + userColumns.length}>
                    <div className="empty">
                      <div className="empty-icon">☰</div>
                      No leads yet. Import a CSV or add one to get started.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'import' && <ImportModal onClose={() => setModal(null)} onDone={leads.refresh} />}
      {modal === 'addLead' && <AddLeadModal onClose={() => setModal(null)} onDone={leads.refresh} />}
      {modal === 'addColumn' && (
        <AddColumnModal onClose={() => setModal(null)} onCreated={columns.refresh} />
      )}
    </>
  );
}

/**
 * One user-column cell. Empty cells show a "Run" affordance (per-cell trigger);
 * filled cells show the value with its confidence and a provenance link, so an
 * operator can trust a number by clicking into where it came from.
 */
function UserCell({ lead, column, onRun }: { lead: Lead; column: Column; onRun: () => void }) {
  const value = lead.data?.[column.key];
  const prov = lead.enrichmentConf?.[column.key];

  if (value === undefined || value === null || value === '') {
    if (column.type === 'manual') return <td className="cell-muted">—</td>;
    return (
      <td>
        <span className="cell-run" onClick={onRun}>
          ▷ Run
        </span>
      </td>
    );
  }

  return (
    <td>
      <span className="cell-strong">{String(value)}</span>
      {prov && (
        <span className="conf" title={`confidence ${(prov.confidence * 100).toFixed(0)}%`}>
          {prov.source ? (
            <a href={prov.source} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>
              ◔ {(prov.confidence * 100).toFixed(0)}%
            </a>
          ) : (
            `◔ ${(prov.confidence * 100).toFixed(0)}%`
          )}
        </span>
      )}
    </td>
  );
}
