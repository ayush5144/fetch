'use client';

import { useSearchParams } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { LeadsGrid } from '@/components/leads/LeadsGrid';
import { useApi } from '@/lib/useApi';
import type { Lead, Column, CellJob } from '@/lib/api';

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
 * All mutations go through LeadsGrid, which calls the API directly and
 * triggers refresh callbacks.
 */
export default function LeadsPageInner() {
  const params = useSearchParams();
  const tableId = params.get('table') ?? DEFAULT_TABLE;

  const leadsApi = useApi<{ leads: Lead[] }>(`/tables/${tableId}/leads`, 4000);
  const columnsApi = useApi<{ columns: Column[] }>(`/tables/${tableId}/columns`, 8000);
  const jobsApi = useApi<{ jobs: CellJob[] }>(`/tables/${tableId}/cell-jobs`, 3000);

  const leads = leadsApi.data?.leads ?? [];
  const columns = columnsApi.data?.columns ?? [];
  const jobs = jobsApi.data?.jobs ?? [];

  const isLoading = leadsApi.loading && columnsApi.loading;

  return (
    <div className="grid-page">
      <Topbar
        title="Leads"
        subtitle={
          leadsApi.loading
            ? 'Loading…'
            : `${leads.length} lead${leads.length !== 1 ? 's' : ''}`
        }
      />

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
          leads={leads}
          columns={columns}
          jobs={jobs}
          onRefreshLeads={leadsApi.refresh}
          onRefreshColumns={columnsApi.refresh}
        />
      )}
    </div>
  );
}
