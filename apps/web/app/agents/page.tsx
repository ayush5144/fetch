'use client';

import { useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { Modal } from '@/components/Modal';
import { agentsApi, type SavedAgent } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Saved Dogi agents — a reusable Dogi column config or a goal-mode plan that
 * was saved from a column's "Save as agent" action. This page is a calm
 * management view: see what you've saved, read a one-line summary of each, and
 * delete the ones you no longer need.
 */
export default function AgentsPage() {
  const agents = useApi<{ agents: SavedAgent[] }>('/agents', 8000);
  const [toDelete, setToDelete] = useState<SavedAgent | null>(null);
  const list = agents.data?.agents ?? [];

  return (
    <>
      <Topbar
        title="Agents"
        subtitle="Reusable Dogi configs and goal plans you've saved."
      />
      <div className="content stack">
        {agents.loading && !agents.data ? (
          <div className="card">
            <div className="empty">Loading agents…</div>
          </div>
        ) : agents.error ? (
          <div className="card">
            <div className="empty" style={{ color: 'var(--red)' }}>
              {agents.error}
            </div>
          </div>
        ) : list.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="empty-icon">🐕</div>
              No saved agents yet. Configure a Dogi column, then choose{' '}
              <span className="kbd">Save as agent</span> to reuse it across tables —
              they'll show up here.
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Summary</th>
                  <th>Saved</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id}>
                    <td className="cell-strong">{a.name}</td>
                    <td>
                      <span className={`pill ${a.kind === 'dogi' ? 'pill-accent' : 'pill-blue'}`}>
                        <span className="dot" />
                        {a.kind === 'dogi' ? 'Dogi' : 'Plan'}
                      </span>
                    </td>
                    <td className="cell-muted" style={{ maxWidth: 420 }}>
                      <span className="agent-summary">{summarize(a)}</span>
                    </td>
                    <td className="muted">{new Date(a.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setToDelete(a)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toDelete && (
        <DeleteAgentModal
          agent={toDelete}
          onClose={() => setToDelete(null)}
          onDone={agents.refresh}
        />
      )}
    </>
  );
}

/**
 * One-line, human summary of an agent's config. A `dogi` agent leads with its
 * instruction; a `dogi-plan` leads with its goal and step count. We fall back
 * to whatever readable text the config has so the row is never blank.
 */
function summarize(a: SavedAgent): string {
  const c = a.config ?? {};
  if (a.kind === 'dogi-plan') {
    const goal = typeof c.goal === 'string' ? c.goal : '';
    const steps = Array.isArray(c.steps) ? c.steps.length : 0;
    const stepLabel = steps ? `${steps} step${steps !== 1 ? 's' : ''}` : 'plan';
    return goal ? `${stepLabel} — ${goal}` : stepLabel;
  }

  const instruction = typeof c.instruction === 'string' ? c.instruction.trim() : '';
  if (instruction) return instruction;

  // No instruction text — describe the data sources instead.
  const sources = Array.isArray(c.sources) ? c.sources : [];
  if (sources.length) {
    const names = sources
      .map((s) => {
        const src = s as { type?: string; name?: string; via?: string };
        if (src.type === 'provider' && src.name) return src.name;
        if (src.type === 'web') return 'web search';
        if (src.type === 'scrape') return 'scrape';
        if (src.type === 'llm') return 'LLM';
        return src.type ?? 'source';
      })
      .filter(Boolean);
    if (names.length) return `Sources: ${names.join(', ')}`;
  }

  return 'Saved Dogi configuration';
}

function DeleteAgentModal({
  agent,
  onClose,
  onDone,
}: {
  agent: SavedAgent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await agentsApi.delete(agent.id);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete agent');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete agent"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={confirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
        Delete <strong>{agent.name}</strong>? This removes the saved config — columns
        you've already created from it keep working.
      </p>
      {error && (
        <p style={{ marginTop: 12, marginBottom: 0, color: 'var(--red)', fontSize: 13 }}>
          {error}
        </p>
      )}
    </Modal>
  );
}
