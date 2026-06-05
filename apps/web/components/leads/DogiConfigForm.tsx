'use client';

/**
 * DogiConfigForm — Phase C extension point.
 *
 * Currently captures the `instruction` string and exposes it via onChange.
 * Phase C will wire up the full Dogi config (reads, sources, policy, brain)
 * and replace this stub with the rich form described in dogi-agent.md §2.
 */
export interface DogiConfig {
  instruction: string;
  reads: string[];
}

interface Props {
  value: DogiConfig;
  onChange: (v: DogiConfig) => void;
  availableColumns?: { key: string; label: string }[];
}

export function DogiConfigForm({ value, onChange, availableColumns = [] }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>What should Dogi find?</label>
        <textarea
          className="textarea"
          placeholder="e.g. Find this company's CEO's email address."
          value={value.instruction}
          onChange={(e) => onChange({ ...value, instruction: e.target.value })}
          style={{ minHeight: 70 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Plain language — no jargon needed.
        </span>
      </div>

      {availableColumns.length > 0 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Reads from (optional)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {availableColumns.map((col) => {
              const checked = value.reads.includes(col.key);
              return (
                <button
                  key={col.key}
                  type="button"
                  className={`pill ${checked ? 'pill-accent' : ''}`}
                  style={{ cursor: 'pointer', background: checked ? undefined : 'var(--surface-2)' }}
                  onClick={() => {
                    const next = checked
                      ? value.reads.filter((k) => k !== col.key)
                      : [...value.reads, col.key];
                    onChange({ ...value, reads: next });
                  }}
                >
                  {col.label}
                </button>
              );
            })}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Columns Dogi can see when filling this cell.
          </span>
        </div>
      )}

      {/* Phase C: sources, policy, brain — wired up in Phase C */}
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          color: 'var(--muted)',
          border: '1px dashed var(--border-strong)',
        }}
      >
        Sources, policy (combine / first), and model are configured in Phase C.
      </div>
    </div>
  );
}
