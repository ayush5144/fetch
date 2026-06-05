'use client';

import { useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { Modal } from '@/components/Modal';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Prompt {
  id: string;
  name: string;
  version: number;
  body: string;
  guardrails: { maxLength?: number; requiredVars?: string[]; bannedClaims?: string[] };
}

/**
 * Prompt editor — versioned templates for personalization (and agent columns).
 * Saving an edit creates a new version, so approved copy under an older version
 * is never silently changed.
 */
export default function PromptsPage() {
  const prompts = useApi<{ prompts: Prompt[] }>('/prompts', 8000);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Topbar
        title="Prompts"
        subtitle="Versioned templates with guardrails."
        actions={
          <button className="btn btn-accent" onClick={() => setOpen(true)}>
            New prompt
          </button>
        }
      />
      <div className="content stack">
        {(prompts.data?.prompts ?? []).map((p) => (
          <div className="card" key={p.id}>
            <div className="card-head">
              <div className="row" style={{ gap: 8 }}>
                <h3>{p.name}</h3>
                <span className="pill pill-muted">v{p.version}</span>
              </div>
              {p.guardrails?.maxLength && (
                <span className="muted" style={{ fontSize: 12 }}>
                  max {p.guardrails.maxLength} chars
                </span>
              )}
            </div>
            <div className="card-pad">
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--mono)',
                  fontSize: 12.5,
                  color: 'var(--ink-soft)',
                }}
              >
                {p.body}
              </pre>
            </div>
          </div>
        ))}
        {(prompts.data?.prompts ?? []).length === 0 && (
          <div className="card">
            <div className="empty">
              <div className="empty-icon">✎</div>
              No prompts yet. Create one to drive personalization.
            </div>
          </div>
        )}
      </div>
      {open && <NewPromptModal onClose={() => setOpen(false)} onDone={prompts.refresh} />}
    </>
  );
}

function NewPromptModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState(
    'Write a 2-sentence cold email to {{first_name}}, {{title}} at their company.\nReference {{recent_signal}} if available. Keep it specific and human.',
  );
  const [maxLength, setMaxLength] = useState(600);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/prompts', { name, body, guardrails: { maxLength, requiredVars: ['first_name'] } });
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New prompt"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !name} onClick={submit}>
            Save v1
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Outbound — founders" />
      </div>
      <div className="field">
        <label>Template body</label>
        <textarea className="textarea" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <span className="muted" style={{ fontSize: 12 }}>
          Use <span className="kbd">{'{{variable}}'}</span> tokens — they bind from lead, account, and user columns.
        </span>
      </div>
      <div className="field">
        <label>Max body length</label>
        <input
          className="input"
          type="number"
          value={maxLength}
          onChange={(e) => setMaxLength(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}
