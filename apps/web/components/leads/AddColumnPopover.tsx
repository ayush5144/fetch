'use client';

import { useEffect, useRef, useState } from 'react';
import { DogiConfigForm, type DogiConfig, type SearchAvailability } from './DogiConfigForm';
import { agentsApi, type ValueType, type FillMethod, type Column, type SavedAgent } from '@/lib/api';
import { PREDEFINED_FIELDS } from '@/lib/predefinedFields';

/**
 * Inline popover for creating or editing a column. Anchored next to the
 * trigger element, not a centered modal.
 *
 * When `editColumn` is provided the popover is in edit mode — it pre-fills
 * from the existing column and submits via `onEdit` (PATCH /columns/:id).
 *
 * Friendly names and icons per leads-grid.md §2.1.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

interface TypeDef {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  group: 'value' | 'fill';
  valueType?: ValueType;
  fillMethod?: FillMethod;
}

const TYPES: TypeDef[] = [
  // Value types
  { id: 'text',     label: 'Text',     icon: 'T',  blurb: 'Any text',     group: 'value', valueType: 'text',     fillMethod: 'manual' },
  { id: 'email',    label: 'Email',    icon: '✉',  blurb: 'Valid email',  group: 'value', valueType: 'email',    fillMethod: 'manual' },
  { id: 'url',      label: 'URL',      icon: '🔗', blurb: 'A link',       group: 'value', valueType: 'url',      fillMethod: 'manual' },
  { id: 'number',   label: 'Number',   icon: '#',  blurb: 'Numeric',      group: 'value', valueType: 'number',   fillMethod: 'manual' },
  { id: 'date',     label: 'Date',     icon: '📅', blurb: 'A date',       group: 'value', valueType: 'date',     fillMethod: 'manual' },
  { id: 'select',   label: 'Select',   icon: '▾',  blurb: 'Pick one',     group: 'value', valueType: 'select',   fillMethod: 'manual' },
  { id: 'checkbox', label: 'Checkbox', icon: '☑',  blurb: 'Yes / no',     group: 'value', valueType: 'checkbox', fillMethod: 'manual' },
  // Fill methods
  { id: 'dogi',    label: 'Dogi (AI)', icon: '🐕', blurb: 'Agent fills it', group: 'fill', fillMethod: 'dogi',    valueType: 'text' },
  { id: 'formula', label: 'Formula',   icon: 'ƒ',  blurb: 'Derived',        group: 'fill', fillMethod: 'formula', valueType: 'text' },
  { id: 'manual',  label: 'Manual',    icon: '✎',  blurb: 'You type it',    group: 'fill', fillMethod: 'manual',  valueType: 'text' },
];

/**
 * Optional quick-pick presets for common data-ready fields come from the shared
 * predefined-fields registry (single source of truth — see
 * lib/predefinedFields.ts / devx/predefined-fields.md). Picking one pre-fills
 * the column name + value type (and snake_cases the key via the same derivation
 * as a typed name). Purely a convenience — the user can ignore them and type a
 * fully custom name/type instead.
 */

const DEFAULT_DOGI_CONFIG: DogiConfig = {
  instruction: '',
  reads: [],
  output: { mode: 'fill' },
  sources: [],
  policy: 'combine',
};

export interface ColumnPayload {
  key: string;
  label: string;
  type: string;
  config: Record<string, unknown>;
  /**
   * For a dogi column: whether to auto-run the new column immediately after
   * creating it (default true). Manual/formula columns never run, so this is
   * undefined for them. The grid gates its auto-run on this flag.
   */
  runNow?: boolean;
}

interface Props {
  anchorRect: DOMRect;
  tableId: string;
  availableColumns?: { key: string; label: string }[];
  /** Web-search / scrape backend availability, passed to the Dogi config form. */
  searchAvailability?: SearchAvailability;
  /** If provided, the popover is in edit mode and pre-populates from this column. */
  editColumn?: Column;
  onSubmit: (payload: ColumnPayload) => Promise<void>;
  /** Called when editing an existing column (PATCH). If not provided, falls back to onSubmit. */
  onEdit?: (columnId: string, patch: { label: string; config: Record<string, unknown> }) => Promise<void>;
  onClose: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function typeDefFromColumn(col: Column): TypeDef {
  // Determine which TypeDef best represents this column
  if (col.type === 'dogi') return TYPES.find((t) => t.id === 'dogi')!;
  if (col.type === 'formula') return TYPES.find((t) => t.id === 'formula')!;
  const vt = col.config?.valueType as string | undefined;
  return TYPES.find((t) => t.valueType === vt) ?? TYPES[0];
}

function dogiConfigFromColumn(col: Column): DogiConfig {
  const c = col.config as Record<string, unknown>;
  return {
    instruction: (c.instruction as string) ?? '',
    reads: (c.reads as string[]) ?? [],
    output: (c.output as DogiConfig['output']) ?? { mode: 'fill' },
    sources: (c.sources as DogiConfig['sources']) ?? [],
    policy: (c.policy as DogiConfig['policy']) ?? 'combine',
    brain: c.brain as DogiConfig['brain'],
  };
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AddColumnPopover({
  anchorRect,
  onSubmit,
  onEdit,
  onClose,
  availableColumns = [],
  searchAvailability,
  editColumn,
}: Props) {
  const isEdit = Boolean(editColumn);

  const [label, setLabel] = useState(() => editColumn?.label ?? '');
  const [selectedType, setSelectedType] = useState<TypeDef>(() =>
    editColumn ? typeDefFromColumn(editColumn) : TYPES[0],
  );
  const [formula, setFormula] = useState(() =>
    (editColumn?.config?.expr as string) ?? '',
  );
  const [selectOptions, setSelectOptions] = useState(() =>
    ((editColumn?.config?.options as string[]) ?? []).join(', '),
  );
  const [dogiConfig, setDogiConfig] = useState<DogiConfig>(() =>
    editColumn?.type === 'dogi' ? dogiConfigFromColumn(editColumn) : DEFAULT_DOGI_CONFIG,
  );
  const [apiKey, setApiKey] = useState('');
  // For a new dogi column: run it immediately after creating (default ON). When
  // off, the column is created empty and the grid does NOT auto-run it.
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // Phase E — saved agents
  const [savedAgents, setSavedAgents] = useState<SavedAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  // Load saved agents once when the popover opens (for Dogi columns)
  useEffect(() => {
    if (agentsLoaded) return;
    setAgentsLoaded(true);
    agentsApi.list().then((res) => setSavedAgents(res.agents ?? [])).catch(() => {/* silently ignore */});
  }, [agentsLoaded]);

  // Position the popover near the anchor
  const style: React.CSSProperties = {
    top: Math.min(anchorRect.bottom + 4, window.innerHeight - 500),
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 360)),
  };

  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  function buildConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      valueType: selectedType.valueType,
      fillMethod: selectedType.fillMethod,
    };
    if (selectedType.id === 'formula') {
      config.expr = formula;
    }
    if (selectedType.id === 'select') {
      config.options = selectOptions.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (selectedType.id === 'dogi') {
      config.instruction = dogiConfig.instruction;
      config.reads = dogiConfig.reads;
      config.output = dogiConfig.output;
      config.sources = dogiConfig.sources;
      config.policy = dogiConfig.policy;
      if (dogiConfig.brain) config.brain = dogiConfig.brain;
    }
    return config;
  }

  async function submit() {
    if (!key && !isEdit) return;
    if (isEdit && !label.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const config = buildConfig();

      if (isEdit && editColumn && onEdit) {
        await onEdit(editColumn.id, { label: label.trim(), config });
      } else {
        // Map to backend type
        const backendType =
          selectedType.id === 'dogi' ? 'dogi' :
          selectedType.id === 'formula' ? 'formula' :
          'manual';
        await onSubmit({
          key,
          label,
          type: backendType,
          config,
          // Only a dogi column can auto-run; gate it on the "Run now" toggle.
          runNow: backendType === 'dogi' ? runNow : undefined,
        });
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      setErr(
        msg.includes('already exists') || msg.includes('duplicate') || msg.includes('409')
          ? `A column named "${label}" already exists in this table.`
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') onClose();
  }

  const valueTypes = TYPES.filter((t) => t.group === 'value');
  const fillTypes = TYPES.filter((t) => t.group === 'fill');

  return (
    <>
      <div className="col-popover-backdrop" onClick={onClose} />
      <div
        className="col-popover"
        style={{
          ...style,
          width: selectedType.id === 'dogi' ? 380 : 320,
          maxHeight: 'min(80vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 0,
        }}
        ref={popRef}
        onKeyDown={handleKeyDown}
      >
        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {/* Header */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 14 }}>
            {isEdit ? 'Edit column' : 'Add column'}
          </div>

          {/* Label */}
          <div className="field" style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 4, display: 'block' }}>
              Column name
            </label>
            <input
              ref={labelRef}
              className="input"
              placeholder="e.g. Company size"
              value={label}
              onChange={(e) => { setLabel(e.target.value); setErr(null); }}
              style={{ fontSize: 13 }}
            />
            {!isEdit && key && (
              <span className="muted" style={{ fontSize: 11 }}>
                key: <span className="kbd">{key}</span>
              </span>
            )}
          </div>

          {/* Common-field quick-picks (optional convenience — create mode only) */}
          {!isEdit && (
            <div style={{ marginBottom: 12 }}>
              <div className="type-picker-section">Common fields (optional)</div>
              <div className="field-templates">
                {PREDEFINED_FIELDS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className="field-template-chip"
                    title={`Pre-fill name + ${t.valueType} type`}
                    onClick={() => {
                      setLabel(t.label);
                      setErr(null);
                      const td = TYPES.find(
                        (x) => x.group === 'value' && x.valueType === t.valueType,
                      );
                      if (td) setSelectedType(td);
                    }}
                  >
                    <span className="field-template-icon" aria-hidden>{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Type picker (hidden in edit mode — type can't change) */}
          {!isEdit && (
            <div style={{ marginBottom: 8 }}>
              <div className="type-picker-section">Value type</div>
              <div className="type-picker">
                {valueTypes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`type-picker-item ${selectedType.id === t.id ? 'selected' : ''}`}
                    onClick={() => setSelectedType(t)}
                    title={t.blurb}
                  >
                    <span className="type-picker-icon">{t.icon}</span>
                    <span className="type-picker-label">{t.label}</span>
                  </button>
                ))}
              </div>

              <div className="type-picker-section" style={{ marginTop: 8 }}>Fill method</div>
              <div className="type-picker" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {fillTypes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`type-picker-item ${selectedType.id === t.id ? 'selected' : ''}`}
                    onClick={() => setSelectedType(t)}
                    title={t.blurb}
                  >
                    <span className="type-picker-icon">{t.icon}</span>
                    <span className="type-picker-label">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Formula input */}
          {selectedType.id === 'formula' && (
            <div className="field" style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 4 }}>
                Expression
              </label>
              <input
                className="input"
                placeholder="e.g. company_size * 0.5"
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </div>
          )}

          {/* Select options */}
          {selectedType.id === 'select' && (
            <div className="field" style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 4 }}>
                Options (comma-separated)
              </label>
              <input
                className="input"
                placeholder="e.g. Hot, Warm, Cold"
                value={selectOptions}
                onChange={(e) => setSelectOptions(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </div>
          )}

          {/* Dogi config */}
          {selectedType.id === 'dogi' && (
            <div style={{ marginBottom: 4 }}>
              {/* Phase E — Use a saved agent */}
              {savedAgents.length > 0 && (
                <div className="field" style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 4 }}>
                    Use a saved agent
                  </label>
                  <select
                    className="select"
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const agent = savedAgents.find((a) => a.id === e.target.value);
                      if (!agent) return;
                      // Pre-fill config from saved agent (still editable)
                      const cfg = agent.config as Partial<DogiConfig>;
                      setDogiConfig({
                        instruction: cfg.instruction ?? '',
                        reads: cfg.reads ?? [],
                        output: cfg.output ?? { mode: 'fill' },
                        sources: cfg.sources ?? [],
                        policy: cfg.policy ?? 'combine',
                        brain: cfg.brain,
                      });
                      // Pre-fill label if empty
                      if (!label) setLabel(agent.name);
                    }}
                    style={{ fontSize: 12 }}
                  >
                    <option value="">Pick a saved agent…</option>
                    {savedAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <span className="muted" style={{ fontSize: 11 }}>
                    Pre-fills the config below — you can still edit everything.
                  </span>
                </div>
              )}

              <DogiConfigForm
                value={dogiConfig}
                onChange={setDogiConfig}
                availableColumns={availableColumns}
                availability={searchAvailability}
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                onSaveAsAgent={async (agentName) => {
                  const config: Record<string, unknown> = {
                    instruction: dogiConfig.instruction,
                    reads: dogiConfig.reads,
                    output: dogiConfig.output,
                    sources: dogiConfig.sources,
                    policy: dogiConfig.policy,
                  };
                  if (dogiConfig.brain) config.brain = dogiConfig.brain;
                  const res = await agentsApi.save(agentName, 'dogi', config);
                  // Refresh local list so the new agent immediately appears
                  setSavedAgents((prev) => [...prev, res.agent]);
                }}
              />

              {/* Build-only vs Build-and-run — create mode only. On: run the new
                  column across the table now. Off: create it empty, run later. */}
              {!isEdit && (
                <label
                  className="bone-toggle"
                  style={{ marginTop: 12 }}
                  title="On: fill this column now. Off: just create it — run it later with ▷ Run."
                >
                  <input
                    type="checkbox"
                    checked={runNow}
                    onChange={(e) => setRunNow(e.target.checked)}
                  />
                  <span>Run now</span>
                </label>
              )}
            </div>
          )}

          {/* Error */}
          {err && (
            <div style={{
              padding: '8px 10px',
              background: 'var(--red-soft)',
              color: 'var(--red)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              marginTop: 8,
            }}>
              {err}
            </div>
          )}
        </div>

        {/* Sticky footer — always reachable */}
        <div style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg)',
          flexShrink: 0,
        }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-accent btn-sm"
            disabled={busy || (!isEdit && !key) || (isEdit && !label.trim())}
            onClick={submit}
            type="button"
          >
            {busy
              ? isEdit ? 'Saving…' : 'Creating…'
              : isEdit ? 'Save changes' : 'Add column'}
          </button>
        </div>
      </div>
    </>
  );
}
