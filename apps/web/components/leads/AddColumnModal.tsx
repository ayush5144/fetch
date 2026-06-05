'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { api } from '@/lib/api';

/**
 * Create a dynamic column. The form mirrors the engine's four types and the
 * config each one needs: a waterfall field (enrichment), a research prompt
 * (agent), a formula expression, or nothing (manual). This is the UI half of
 * "a column is a reusable job definition".
 */
const TYPES = [
  { id: 'enrichment', blurb: 'Fill from a provider waterfall (Apollo → Hunter → …).' },
  { id: 'agent', blurb: 'Fill with an LLM research loop driven by your prompt.' },
  { id: 'formula', blurb: 'Derive from other columns (no cost).' },
  { id: 'manual', blurb: 'A value you type in yourself.' },
] as const;

export function AddColumnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]['id']>('enrichment');
  const [config, setConfig] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const parsedConfig =
        type === 'enrichment'
          ? { field: key, providers: ['apollo', 'hunter'] }
          : type === 'agent'
            ? { prompt: config || `Find ${label} for this lead.`, outputField: key }
            : type === 'formula'
              ? { kind: 'arithmetic', expr: config }
              : {};
      await api.post('/columns', { key, label, type, config: parsedConfig });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add column"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !key} onClick={submit}>
            {busy ? 'Creating…' : 'Create column'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Column name</label>
        <input
          className="input"
          placeholder="e.g. Company size"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {key && (
          <span className="muted" style={{ fontSize: 12 }}>
            stored as <span className="kbd">data.{key}</span>
          </span>
        )}
      </div>

      <div className="field">
        <label>Type</label>
        <div className="stack" style={{ gap: 8 }}>
          {TYPES.map((t) => (
            <div
              key={t.id}
              onClick={() => setType(t.id)}
              style={{
                border: `1px solid ${type === t.id ? 'var(--accent)' : 'var(--border)'}`,
                background: type === t.id ? 'var(--accent-soft)' : 'var(--bg)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                cursor: 'pointer',
              }}
            >
              <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 13, textTransform: 'capitalize' }}>
                {t.id}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {t.blurb}
              </div>
            </div>
          ))}
        </div>
      </div>

      {type === 'agent' && (
        <div className="field">
          <label>Research prompt</label>
          <textarea
            className="textarea"
            placeholder="Find this company's most recent funding round and amount."
            value={config}
            onChange={(e) => setConfig(e.target.value)}
          />
        </div>
      )}
      {type === 'formula' && (
        <div className="field">
          <label>Expression</label>
          <input
            className="input"
            placeholder="company_size * 0.5 + 10"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
          />
        </div>
      )}

      {err && <div className="pill pill-red">{err}</div>}
    </Modal>
  );
}
