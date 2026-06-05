/**
 * Maps a system status string to a calm, color-coded pill. Centralizing the
 * mapping keeps validation/approval/send/job statuses visually consistent
 * everywhere they appear in the table and monitors.
 */
const MAP: Record<string, { cls: string; label?: string }> = {
  // validation
  valid: { cls: 'pill-green' },
  risky: { cls: 'pill-amber' },
  invalid: { cls: 'pill-red' },
  disposable: { cls: 'pill-red' },
  duplicate: { cls: 'pill-muted' },
  no_email: { cls: 'pill-muted', label: 'no email' },
  unchecked: { cls: 'pill-muted' },
  // approval
  draft: { cls: 'pill-muted' },
  ready: { cls: 'pill-blue' },
  approved: { cls: 'pill-green' },
  rejected: { cls: 'pill-red' },
  // send
  none: { cls: 'pill-muted' },
  queued: { cls: 'pill-blue' },
  sent: { cls: 'pill-green' },
  failed: { cls: 'pill-red' },
  // jobs
  active: { cls: 'pill-blue' },
  completed: { cls: 'pill-green' },
  dead: { cls: 'pill-red' },
  // enrichment
  pending: { cls: 'pill-muted' },
  running: { cls: 'pill-blue' },
  done: { cls: 'pill-green' },
};

export function StatusPill({ status }: { status: string }) {
  const m = MAP[status] ?? { cls: 'pill-muted' };
  return (
    <span className={`pill ${m.cls}`}>
      <span className="dot" />
      {m.label ?? status}
    </span>
  );
}
