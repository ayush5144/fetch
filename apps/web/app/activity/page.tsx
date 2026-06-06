'use client';

import { useCallback, useEffect, useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { activityApi, type AuditRow } from '@/lib/api';

/**
 * Activity — a workspace-wide feed over `audit_log` (Phase G.2c). Shows what
 * people and agents (Dogi/Bone) did: columns created, cells filled, rows
 * merged/deleted, sends. Newest first, paginated with "Load more".
 *
 * Fetches on mount via activityApi.list(); no polling — this is a history view.
 */
const PAGE_SIZE = 50;

/** Map an action verb to a calm pill colour, reusing the status-pill palette. */
function actionPill(action: string): string {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('add')) return 'pill-green';
  if (a.includes('delete') || a.includes('remove')) return 'pill-red';
  if (a.includes('merge') || a.includes('dedup')) return 'pill-amber';
  if (a.includes('send')) return 'pill-blue';
  if (a.includes('update') || a.includes('edit') || a.includes('run') || a.includes('fill'))
    return 'pill-blue';
  return 'pill-muted';
}

/** Pull a human-friendly field name out of the diff, if one is present. */
function diffField(diff: AuditRow['diff']): string | null {
  if (!diff || typeof diff !== 'object') return null;
  const d = diff as Record<string, unknown>;
  for (const k of ['field', 'key', 'column', 'columnKey', 'label']) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ActivityPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset: number) => {
    const isFirst = offset === 0;
    if (isFirst) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const res = await activityApi.list(PAGE_SIZE, offset);
      const incoming = res?.activity ?? [];
      setTotal(res?.total ?? incoming.length);
      setRows((prev) => (isFirst ? incoming : [...prev, ...incoming]));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load activity.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const hasMore = rows.length < total;

  return (
    <>
      <Topbar
        title="Activity"
        subtitle="What you and the agents did across the workspace — newest first."
      />
      <div className="content stack">
        {loading ? (
          <div className="muted" style={{ padding: 48, textAlign: 'center' }}>
            Loading activity…
          </div>
        ) : error ? (
          <div className="table-wrap">
            <div className="empty">
              <div className="empty-icon">⚠</div>
              {error}
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="table-wrap">
            <div className="empty">
              <div className="empty-icon">≡</div>
              No activity yet. Run a column or dedupe a table and it&apos;ll show up here.
            </div>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <ul className="activity-list">
                {rows.map((r) => {
                  const field = diffField(r.diff);
                  return (
                    <li className="activity-row" key={r.id}>
                      <span className={`pill ${actionPill(r.action)}`}>
                        <span className="dot" />
                        {r.action}
                      </span>
                      <span className="activity-entity">
                        {r.entity}
                        {r.entityId && (
                          <span className="activity-id" title={r.entityId}>
                            {' '}
                            {r.entityId.slice(0, 8)}
                          </span>
                        )}
                      </span>
                      {field && <span className="activity-field">· {field}</span>}
                      <span className="activity-spacer" />
                      <span className="activity-actor">{r.actor}</span>
                      <span className="activity-time" title={new Date(r.createdAt).toLocaleString()}>
                        {relativeTime(r.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            {hasMore && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={loadingMore}
                  onClick={() => load(rows.length)}
                >
                  {loadingMore ? 'Loading…' : `Load more (${total - rows.length})`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
