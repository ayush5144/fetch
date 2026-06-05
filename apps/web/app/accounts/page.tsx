'use client';

import { Topbar } from '@/components/Topbar';
import { useApi } from '@/lib/useApi';

interface Account {
  id: string;
  domain: string;
  name: string | null;
  industry: string | null;
  size: number | null;
}

/**
 * Accounts — the company view. One account per domain (the dedupe key), enriched
 * once and shared across every lead at that company.
 */
export default function AccountsPage() {
  const accounts = useApi<{ accounts: Account[] }>('/accounts', 6000);

  return (
    <>
      <Topbar title="Accounts" subtitle="One company per domain, shared across its leads." />
      <div className="content">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Domain</th>
                <th>Industry</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {(accounts.data?.accounts ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="cell-strong">{a.name ?? <span className="cell-muted">—</span>}</td>
                  <td className="cell-mono">{a.domain}</td>
                  <td>{a.industry ?? <span className="cell-muted">—</span>}</td>
                  <td>{a.size ?? <span className="cell-muted">—</span>}</td>
                </tr>
              ))}
              {(accounts.data?.accounts ?? []).length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty">
                      <div className="empty-icon">◇</div>
                      No accounts yet. They're created automatically when leads import with a domain.
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
