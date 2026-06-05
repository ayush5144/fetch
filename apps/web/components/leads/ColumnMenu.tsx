'use client';

/**
 * Per-column ⋯ context menu.
 * Positioned near the trigger button; closes on backdrop click or Escape.
 *
 * When `isProtected` is true the Delete action is hidden (the column is a
 * fixed column on the example/protected table and cannot be removed).
 */
interface Props {
  anchorRect: DOMRect;
  columnKey: string;
  columnLabel: string;
  isRunnable: boolean;
  /** When true the Delete option is hidden (protected column). */
  isProtected?: boolean;
  onRun: () => void;
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
  onEdit,
  onRename,
  onDuplicate,
  onInsertLeft,
  onInsertRight,
  onDelete,
  onClose,
}: Props) {
  const top = Math.min(anchorRect.bottom + 2, window.innerHeight - 280);
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 200));

  function handle(fn: () => void) {
    return () => { fn(); onClose(); };
  }

  return (
    <>
      <div className="col-menu-backdrop" onClick={onClose} />
      <div className="col-menu" style={{ top, left }} role="menu">
        {isRunnable && (
          <>
            <button className="col-menu-item" onClick={handle(onRun)}>
              <span>▷</span> Run column
            </button>
            <div className="col-menu-sep" />
          </>
        )}
        <button className="col-menu-item" onClick={handle(onEdit)}>
          <span>✎</span> Edit column
        </button>
        <button className="col-menu-item" onClick={handle(onRename)}>
          <span>Aa</span> Rename
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
