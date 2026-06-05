'use client';

/**
 * Per-column ⋯ context menu.
 * Positioned near the trigger button; closes on backdrop click or Escape.
 *
 * When `isProtected` is true the Delete action is hidden (the column is a
 * fixed column on the example/protected table and cannot be removed).
 *
 * Phase E additions:
 * - "Test 5" — runs the column on only the first 5 empty rows (limit: 5).
 * - "Estimate cost" — calls /estimate-cost and shows an inline pill before
 *   the operator fires a full run.
 */

import { useState } from 'react';

interface Props {
  anchorRect: DOMRect;
  columnKey: string;
  columnLabel: string;
  isRunnable: boolean;
  /** When true the Delete option is hidden (protected column). */
  isProtected?: boolean;
  onRun: () => void;
  /** Phase E — run only the first 5 empty rows. */
  onTest5?: () => void;
  /** Phase G — dedupe existing rows by this column's value. */
  onDedupe?: () => void;
  /** Phase E — show a cost estimate inline (returns a formatted string like "≈ $0.12 for 50 rows"). */
  onEstimateCost?: () => Promise<string | null>;
  onEdit: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ColumnMenu({
  anchorRect,
  isRunnable,
  isProtected,
  onRun,
  onTest5,
  onDedupe,
  onEstimateCost,
  onEdit,
  onRename,
  onDuplicate,
  onInsertLeft,
  onInsertRight,
  onDelete,
  onClose,
}: Props) {
  const top = Math.min(anchorRect.bottom + 2, window.innerHeight - 340);
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 220));

  // Phase E — inline cost estimate state
  const [costEstimate, setCostEstimate] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);

  function handle(fn: () => void) {
    return () => { fn(); onClose(); };
  }

  async function handleEstimate() {
    if (!onEstimateCost) return;
    setEstimating(true);
    setCostEstimate(null);
    try {
      const result = await onEstimateCost();
      setCostEstimate(result);
    } finally {
      setEstimating(false);
    }
  }

  return (
    <>
      <div className="col-menu-backdrop" onClick={onClose} />
      <div className="col-menu" style={{ top, left }} role="menu">
        {isRunnable && (
          <>
            {/* Cost estimate pill — shown above run actions */}
            {onEstimateCost && costEstimate && (
              <div style={{
                padding: '5px 12px',
                fontSize: 11,
                color: 'var(--ink-soft)',
                background: 'var(--surface)',
                borderBottom: '1px solid var(--border)',
              }}>
                {costEstimate}
              </div>
            )}
            <button className="col-menu-item" onClick={handle(onRun)}>
              <span>▷</span> Run column
            </button>
            {onTest5 && (
              <button className="col-menu-item" onClick={handle(onTest5)}>
                <span>⚡</span> Test 5 rows
              </button>
            )}
            {onEstimateCost && (
              <button
                className="col-menu-item"
                disabled={estimating}
                onClick={handleEstimate}
                style={{ color: 'var(--muted)' }}
              >
                <span>$</span> {estimating ? 'Estimating…' : 'Estimate cost'}
              </button>
            )}
            <div className="col-menu-sep" />
          </>
        )}
        {onDedupe && (
          <>
            <button className="col-menu-item" onClick={handle(onDedupe)}>
              <span>⧓</span> Dedupe rows by this column
            </button>
            <div className="col-menu-sep" />
          </>
        )}
        <button className="col-menu-item" onClick={handle(onRename)}>
          <span>Aa</span> Edit name
        </button>
        <button className="col-menu-item" onClick={handle(onEdit)}>
          <span>✎</span> Edit type / config
        </button>
        <button className="col-menu-item" onClick={handle(onDuplicate)}>
          <span>⧉</span> Duplicate
        </button>
        <div className="col-menu-sep" />
        <button className="col-menu-item" onClick={handle(onInsertLeft)}>
          <span>←</span> Insert left
        </button>
        <button className="col-menu-item" onClick={handle(onInsertRight)}>
          <span>→</span> Insert right
        </button>
        {!isProtected && (
          <>
            <div className="col-menu-sep" />
            <button className="col-menu-item danger" onClick={handle(onDelete)}>
              <span>🗑</span> Delete column
            </button>
          </>
        )}
      </div>
    </>
  );
}
