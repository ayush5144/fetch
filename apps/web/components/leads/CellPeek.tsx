'use client';

import { isCellFailed, type Lead, type Column } from '@/lib/api';

/**
 * Side-peek panel for a single cell. Shows full value, provenance URL, model,
 * and a Re-run button for Dogi cells.
 */
interface Props {
  lead: Lead;
  column: Column;
  onRerun: () => void;
  onClose: () => void;
}

export function CellPeek({ lead, column, onRerun, onClose }: Props) {
  const value = lead.data?.[column.key];
  const conf = lead.enrichmentConf?.[column.key];
  const failed = isCellFailed(conf);
  // Provenance (confidence/source/model) only exists on a filled conf.
  const prov = failed ? undefined : conf;
  const isComputed = column.type === 'dogi' || column.type === 'enrichment' || column.type === 'agent';

  return (
    <>
      <div className="cell-peek-backdrop" onClick={onClose} />
      <div className="cell-peek">
        <div className="cell-peek-head">
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
              {column.label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {lead.firstName || lead.lastName
                ? [lead.firstName, lead.lastName].filter(Boolean).join(' ')
                : lead.email ?? lead.id}
            </div>
          </div>
          <button
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', lineHeight: 1 }}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="cell-peek-body">
          <div>
            <div className="cell-peek-label">Value</div>
            <div className="cell-peek-value">
              {value !== undefined && value !== null && value !== '' ? (
                String(value)
              ) : (
                <span style={{ color: 'var(--faint)' }}>Empty</span>
              )}
            </div>
          </div>

          {failed && (
            <div className="doggo-banner doggo-banner-amber">
              <strong>⚠ This cell ran but didn’t find a value.</strong>
              {conf?.error && (
                <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>{conf.error}</div>
              )}
              {conf?.at && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                  {new Date(conf.at).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {prov && (
            <>
              {prov.confidence != null && (
                <div>
                  <div className="cell-peek-label">Confidence</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      height: 6,
                      width: 80,
                      background: 'var(--surface-2)',
                      borderRadius: 999,
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.round(prov.confidence * 100)}%`,
                        background: prov.confidence > 0.7 ? 'var(--green)' : prov.confidence > 0.4 ? 'var(--amber)' : 'var(--red)',
                        borderRadius: 999,
                      }} />
                    </div>
                    <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                      {Math.round(prov.confidence * 100)}%
                    </span>
                  </div>
                </div>
              )}

              {prov.source && (
                <div>
                  <div className="cell-peek-label">Source</div>
                  <a
                    href={prov.source}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 13, color: 'var(--blue)', wordBreak: 'break-all' }}
                  >
                    {prov.source}
                  </a>
                </div>
              )}

              {prov.model && (
                <div>
                  <div className="cell-peek-label">Model</div>
                  <div className="cell-peek-value" style={{ fontSize: 13 }}>{prov.model}</div>
                </div>
              )}
            </>
          )}

          {lead.editedKeys?.includes(column.key) && (
            <div style={{
              padding: '8px 10px',
              background: 'var(--amber-soft)',
              color: 'var(--amber)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
            }}>
              This cell was manually edited — the original computed value has been overridden.
            </div>
          )}
        </div>

        {isComputed && (
          <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { onRerun(); onClose(); }} style={{ width: '100%' }}>
              {failed ? '↻ Re-run Dogi' : '▷ Re-run Dogi'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
