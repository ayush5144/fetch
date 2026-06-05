'use client';

import { useEffect, useRef, useState } from 'react';
import { DogiConfigForm, type DogiConfig } from './DogiConfigForm';
import type { ValueType, FillMethod } from '@/lib/api';

/**
 * Inline popover for creating a new column. Anchored next to the + header cell,
 * not a centered modal. Two-step picker: pick a type (value type or fill method)
 * then name it. Submits via the onSubmit callback.
 *
 * Friendly names and icons per leads-grid.md §2.1.
 */

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
  { id: 'text', label: 'Text', icon: 'T', blurb: 'Any text', group: 'value', valueType: 'text', fillMethod: 'manual' },
  { id: 'email', label: 'Email', icon: '✉', blurb: 'Valid email', group: 'value', valueType: 'email', fillMethod: 'manual' },
  { id: 'url', label: 'URL', icon: '🔗', blurb: 'A link', group: 'value', valueType: 'url', fillMethod: 'manual' },
  { id: 'number', label: 'Number', icon: '#', blurb: 'Numeric', group: 'value', valueType: 'number', fillMethod: 'manual' },
  { id: 'date', label: 'Date', icon: '📅', blurb: 'A date', group: 'value', valueType: 'date', fillMethod: 'manual' },
  { id: 'select', label: 'Select', icon: '▾', blurb: 'Pick one', group: 'value', valueType: 'select', fillMethod: 'manual' },
  { id: 'checkbox', label: 'Checkbox', icon: '☑', blurb: 'Yes / no', group: 'value', valueType: 'checkbox', fillMethod: 'manual' },
  // Fill methods
  { id: 'dogi', label: 'Dogi (AI)', icon: '🐕', blurb: 'Agent fills it', group: 'fill', fillMethod: 'dogi', valueType: 'text' },
  { id: 'formula', label: 'Formula', icon: 'ƒ', blurb: 'Derived', group: 'fill', fillMethod: 'formula', valueType: 'text' },
  { id: 'manual', label: 'Manual', icon: '✎', blurb: 'You type it', group: 'fill', fillMethod: 'manual', valueType: 'text' },
];

interface ColumnPayload {
  key: string;
  label: string;
  type: string;
  config: Record<string, unknown>;
}

interface Props {
  anchorRect: DOMRect;
  tableId: string;
  availableColumns?: { key: string; label: string }[];
  onSubmit: (payload: ColumnPayload) => Promise<void>;
  onClose: () => void;
}

export function AddColumnPopover({ anchorRect, onSubmit, onClose, availableColumns = [] }: Props) {
  const [label, setLabel] = useState('');
  const [selectedType, setSelectedType] = useState<TypeDef>(TYPES[0]);
  const [formula, setFormula] = useState('');
  const [selectOptions, setSelectOptions] = useState('');
  const [dogiConfig, setDogiConfig] = useState<DogiConfig>({ instruction: '', reads: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  // Position the popover near the anchor
  const style: React.CSSProperties = {
    top: Math.min(anchorRect.bottom + 4, window.innerHeight - 420),
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 340)),
  };

  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  async function submit() {
    if (!key) return;
    setBusy(true);
    setErr(null);
    try {
      const config: Record<string, unknown> = {
        valueType: selectedType.valueType,
        fillMethod: selectedType.fillMethod,
      };
      if (selectedType.id === 'formula') config.expr = formula;
      if (selectedType.id === 'select') {
        config.options = selectOptions.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (selectedType.id === 'dogi') {
        config.instruction = dogiConfig.instruction;
        config.reads = dogiConfig.reads;
      }

      // Map to backend type
      const backendType =
        selectedType.id === 'dogi' ? 'dogi' :
        selectedType.id === 'formula' ? 'formula' :
        'manual';

      await onSubmit({ key, label, type: backendType, config });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      // Surface duplicate name errors inline
      setErr(msg.includes('already exists') || msg.includes('duplicate') || msg.includes('409')
        ? `A column named "${label}" already exists in this table.`
        : msg);
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
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
      <div className="col-popover" style={style} ref={popRef} onKeyDown={handleKeyDown}>
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
          {key && (
            <span className="muted" style={{ fontSize: 11 }}>
              key: <span className="kbd">{key}</span>
            </span>
          )}
        </div>

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

        {selectedType.id === 'dogi' && (
          <div style={{ marginBottom: 12 }}>
            <DogiConfigForm
              value={dogiConfig}
              onChange={setDogiConfig}
              availableColumns={availableColumns}
            />
          </div>
        )}

        {err && (
          <div style={{
            padding: '8px 10px',
            background: 'var(--red-soft)',
            color: 'var(--red)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            marginBottom: 10,
          }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-accent btn-sm"
            disabled={busy || !key}
            onClick={submit}
            type="button"
          >
            {busy ? 'Creating…' : 'Add column'}
          </button>
        </div>
      </div>
    </>
  );
}
