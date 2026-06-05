'use client';

/** A small, dependency-free modal. Click the backdrop or Cancel to dismiss. */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>{title}</h3>
          <span className="muted" style={{ cursor: 'pointer', fontSize: 18 }} onClick={onClose}>
            ×
          </span>
        </div>
        <div className="card-pad">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
