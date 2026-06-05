'use client';

/**
 * AskDoggoModal — Doggo goal mode UI (the autonomous orchestrator).
 *
 * Doggo is a superset of the old "Ask Dogi" goal planner: a plan can SOURCE
 * ROWS (create entities) and/or build COLUMNS (enrich rows). See devx/doggo.md.
 *
 * Flow:
 *   1. User types a free-text goal and submits → POST /tables/:id/doggo/plan
 *   2. If plan is null, show the friendly reason.
 *   3. Show the plan review: ordered step cards.
 *      - A source-rows step renders as "Create ~{count} {primaryLabel}" with an
 *        editable count (clamped 1–50).
 *      - A column step renders exactly as today (label, instruction, sources,
 *        editable output key, remove).
 *      With "Just do it" ON, planning runs immediately without the review pause.
 *   4. "Approve & build" → POST /tables/:id/doggo/run { plan: { goal, steps } }
 *      → shows the result line and calls onDone so the grid refreshes.
 *
 * Doggo settings (collapsible): pick the brain provider/model and the default
 * sources for columns Doggo creates. These persist to table.settings.doggo and
 * are included on the run call.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  doggoApi,
  doggoSettingsApi,
  settingsApi,
  isSourceRowsStep,
  type DoggoPlan,
  type DoggoPlanStep,
  type ColumnPlanStep,
  type SourceRowsStep,
  type DoggoSettings,
  type DogiSource,
  type LLMProvider,
} from '@/lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceLabel(source: DogiSource): string {
  switch (source.type) {
    case 'provider': return `Provider (${source.name})`;
    case 'web': return `Web search (${source.via})`;
    case 'scrape': return 'Scrape (Firecrawl)';
    case 'llm': return 'LLM';
  }
}

const PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'grok', label: 'xAI Grok' },
];

const PROVIDER_DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
  grok: 'grok-2-latest',
};

function clampCount(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(50, Math.round(n)));
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  tableId: string;
  onClose: () => void;
  /** Called after a successful run so the parent can refresh rows + columns. */
  onDone: (result: { rowsCreated: number; columnsCreated: number; enqueued: number }) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AskDoggoModal({ tableId, onClose, onDone }: Props) {
  // ── Phase 1: goal input
  const [goal, setGoal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Phase 2: plan review
  const [plan, setPlan] = useState<DoggoPlan | null>(null);
  const [noLlmReason, setNoLlmReason] = useState<string | null>(null);

  // ── Editable steps (local copy so the user can tweak before running)
  const [steps, setSteps] = useState<DoggoPlanStep[]>([]);

  // ── Phase 3: running
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // ── "Just do it": skip the review pause and run immediately after planning.
  const [justDoIt, setJustDoIt] = useState(false);

  // ── Doggo settings (collapsible, persisted to table.settings.doggo)
  const [showSettings, setShowSettings] = useState(false);
  const [doggoSettings, setDoggoSettings] = useState<DoggoSettings>({});
  const [defaultModel, setDefaultModel] = useState<{ provider: string; model: string } | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Load current Doggo settings + the server's default model when the modal opens.
  useEffect(() => {
    let alive = true;
    Promise.all([doggoSettingsApi.get(tableId), settingsApi.get()])
      .then(([ds, srv]) => {
        if (!alive) return;
        setDoggoSettings(ds);
        setDefaultModel(srv.llm);
      })
      .catch(() => {/* settings are best-effort; the run still works on env defaults */});
    return () => { alive = false; };
  }, [tableId]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handlePlan() {
    if (!goal.trim()) return;
    setLoading(true);
    setError(null);
    setNoLlmReason(null);
    setRunError(null);
    setPlan(null);
    try {
      const res = await doggoApi.plan(tableId, goal.trim());
      if (!res.plan) {
        setNoLlmReason(res.reason ?? 'No LLM is configured. Add an LLM key in your environment to use Doggo.');
        return;
      }
      const freshSteps = res.plan.steps.map(cloneStep);
      setPlan(res.plan);
      setSteps(freshSteps);
      // "Just do it": run immediately with the freshly planned (unedited) steps.
      if (justDoIt) await runPlan(res.plan, freshSteps);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function cloneStep(s: DoggoPlanStep): DoggoPlanStep {
    if (isSourceRowsStep(s)) return { ...s };
    return { ...s, output: { ...s.output } };
  }

  function setSourceCount(idx: number, count: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === idx && isSourceRowsStep(s) ? { ...s, count: clampCount(count) } : s,
      ),
    );
  }

  function renameOutputKey(stepId: string, newKey: string) {
    setSteps((prev) =>
      prev.map((s) =>
        !isSourceRowsStep(s) && s.id === stepId
          ? { ...s, output: { ...s.output, key: newKey } }
          : s,
      ),
    );
  }

  function removeColumnStep(stepId: string) {
    setSteps((prev) => prev.filter((s) => isSourceRowsStep(s) || s.id !== stepId));
  }

  async function runPlan(p: DoggoPlan, stepsToRun: DoggoPlanStep[]) {
    if (stepsToRun.length === 0) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await doggoApi.run(tableId, { goal: p.goal, steps: stepsToRun });
      onDone(res);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Failed to run the plan');
      setRunning(false);
    }
  }

  function handleApprove() {
    if (plan) void runPlan(plan, steps);
  }

  // ── Settings change → persist to table.settings.doggo (round-trips). ────────

  async function persistSettings(next: DoggoSettings) {
    setDoggoSettings(next);
    setSavingSettings(true);
    try {
      await doggoSettingsApi.save(tableId, next);
    } catch {
      /* non-fatal; the run still works on env defaults */
    } finally {
      setSavingSettings(false);
    }
  }

  function setBrainProvider(provider: LLMProvider) {
    const next: DoggoSettings = {
      ...doggoSettings,
      brain: {
        provider,
        model: PROVIDER_DEFAULT_MODELS[provider],
        keySource: doggoSettings.brain?.keySource ?? 'env',
      },
    };
    void persistSettings(next);
  }

  function setBrainModel(model: string) {
    const provider = doggoSettings.brain?.provider ?? (defaultModel?.provider as LLMProvider) ?? 'openai';
    const next: DoggoSettings = {
      ...doggoSettings,
      brain: { provider, model, keySource: doggoSettings.brain?.keySource ?? 'env' },
    };
    void persistSettings(next);
  }

  const defaultSources = doggoSettings.defaultSources ?? [{ type: 'llm' } as DogiSource];
  const webSearchOn = defaultSources.some((s) => s.type === 'web');

  function toggleWebSearch(on: boolean) {
    const withoutWeb = defaultSources.filter((s) => s.type !== 'web');
    const next: DoggoSettings = {
      ...doggoSettings,
      defaultSources: on
        ? [{ type: 'web', via: 'native' }, ...withoutWeb]
        : withoutWeb.length > 0 ? withoutWeb : [{ type: 'llm' }],
    };
    void persistSettings(next);
  }

  const brainProvider = (doggoSettings.brain?.provider as LLMProvider | undefined)
    ?? (defaultModel?.provider as LLMProvider | undefined)
    ?? 'openai';
  const brainModel = doggoSettings.brain?.model ?? defaultModel?.model ?? '';

  // ── Render: goal input phase ───────────────────────────────────────────────

  if (!plan) {
    return (
      <Modal
        title="Ask Doggo 🐕"
        onClose={onClose}
        maxWidth={520}
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
            <label className="doggo-toggle" title="Run the plan immediately instead of pausing to review it.">
              <input
                type="checkbox"
                checked={justDoIt}
                onChange={(e) => setJustDoIt(e.target.checked)}
              />
              <span>Just do it</span>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-accent btn-sm"
                disabled={!goal.trim() || loading || running}
                onClick={handlePlan}
              >
                {running ? 'Working…' : loading ? 'Planning…' : justDoIt ? 'Plan & run' : 'Ask Doggo'}
              </button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6 }}>
            Describe what you want. Doggo can <strong>create rows</strong> (e.g. "top 10 EV companies") and
            <strong> build columns</strong> to enrich them — then fill everything in order.
          </p>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Your goal</label>
            <textarea
              className="textarea"
              placeholder="e.g. Top 10 AI infra companies, their CEOs, and the CEO's LinkedIn"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePlan();
              }}
              style={{ minHeight: 90, fontFamily: 'inherit', fontSize: 13 }}
              autoFocus
            />
            <span className="muted" style={{ fontSize: 12 }}>
              Plain language — no jargon needed. Press Cmd+Enter to submit.
            </span>
          </div>

          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            <strong>Just do it</strong> runs the plan as soon as it's ready — leave it off to review first.
          </p>

          <DoggoSettingsSection
            open={showSettings}
            onToggle={() => setShowSettings((v) => !v)}
            brainProvider={brainProvider}
            brainModel={brainModel}
            defaultModel={defaultModel}
            webSearchOn={webSearchOn}
            saving={savingSettings}
            onProvider={setBrainProvider}
            onModel={setBrainModel}
            onWebSearch={toggleWebSearch}
          />

          {noLlmReason && (
            <div className="doggo-banner doggo-banner-amber">
              <strong>No LLM configured</strong>
              <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>{noLlmReason}</div>
            </div>
          )}

          {error && <div className="doggo-banner doggo-banner-red">{error}</div>}
          {runError && <div className="doggo-banner doggo-banner-red">{runError}</div>}
        </div>
      </Modal>
    );
  }

  // ── Render: plan review phase ──────────────────────────────────────────────

  const columnCount = steps.filter((s) => !isSourceRowsStep(s)).length;
  const sourceCount = steps.filter(isSourceRowsStep).length;

  function approveLabel() {
    const parts: string[] = [];
    if (sourceCount > 0) parts.push(`${sourceCount} source`);
    if (columnCount > 0) parts.push(`${columnCount} column${columnCount !== 1 ? 's' : ''}`);
    return parts.length > 0 ? `Approve & build (${parts.join(', ')})` : 'Approve & build';
  }

  return (
    <Modal
      title="Review Doggo's plan 🐕"
      onClose={onClose}
      maxWidth={600}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setPlan(null); setSteps([]); setRunError(null); }}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-accent btn-sm"
              disabled={steps.length === 0 || running}
              onClick={handleApprove}
            >
              {running ? 'Building…' : approveLabel()}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Goal summary */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 14px',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Goal
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{plan.goal}</div>
        </div>

        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Doggo will run these steps in order — create rows first, then build and fill columns.
          Adjust counts or output names below before approving.
        </p>

        {/* Steps in order */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {steps.map((step, idx) =>
            isSourceRowsStep(step) ? (
              <SourceRowsCard
                key={`source-${idx}`}
                step={step}
                index={idx}
                onCountChange={(n) => setSourceCount(idx, n)}
              />
            ) : (
              <ColumnStepCard
                key={step.id}
                step={step}
                index={idx}
                allSteps={steps}
                onRenameKey={(newKey) => renameOutputKey(step.id, newKey)}
                onRemove={() => removeColumnStep(step.id)}
              />
            ),
          )}
        </div>

        {steps.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            All steps removed. Go back to ask again.
          </div>
        )}

        {runError && <div className="doggo-banner doggo-banner-red">{runError}</div>}
      </div>
    </Modal>
  );
}

// ── SourceRowsCard ────────────────────────────────────────────────────────────

function SourceRowsCard({
  step,
  index,
  onCountChange,
}: {
  step: SourceRowsStep;
  index: number;
  onCountChange: (n: number) => void;
}) {
  return (
    <div className="doggo-step doggo-step-source">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StepNumber n={index + 1} />
        <span className="pill pill-accent" style={{ fontSize: 11, padding: '2px 8px' }}>
          Create rows
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
        Create <strong>~{step.count}</strong> {step.primaryLabel}
        {' '}from <em>“{step.description}”</em>.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          How many
        </span>
        <input
          className="input"
          type="number"
          min={1}
          max={50}
          value={step.count}
          onChange={(e) => onCountChange(Number(e.target.value))}
          style={{ width: 80, fontSize: 12, padding: '4px 8px' }}
        />
        <span className="muted" style={{ fontSize: 12 }}>(1–50)</span>
        <span className="pill pill-green" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}>
          New rows
        </span>
      </div>
    </div>
  );
}

// ── ColumnStepCard ────────────────────────────────────────────────────────────

interface ColumnCardProps {
  step: ColumnPlanStep;
  index: number;
  allSteps: DoggoPlanStep[];
  onRenameKey: (newKey: string) => void;
  onRemove: () => void;
}

function ColumnStepCard({ step, index, allSteps, onRenameKey, onRemove }: ColumnCardProps) {
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(step.output.key);

  function commitRename() {
    const trimmed = keyDraft.trim().replace(/\s+/g, '_').toLowerCase();
    if (trimmed && trimmed !== step.output.key) {
      onRenameKey(trimmed);
    } else {
      setKeyDraft(step.output.key);
    }
    setEditingKey(false);
  }

  // Labels for the steps this one depends on.
  const depLabels = step.dependsOn
    .map((depId) => {
      const dep = allSteps.find((s) => !isSourceRowsStep(s) && s.id === depId) as
        | ColumnPlanStep
        | undefined;
      return dep ? dep.label : depId;
    })
    .filter(Boolean);

  return (
    <div className="doggo-step">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <StepNumber n={index + 1} />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {step.label}
          </span>
        </div>
        <button
          onClick={onRemove}
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--muted)',
            fontSize: 13,
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'inherit',
          }}
          title="Remove this step"
        >
          Remove
        </button>
      </div>

      {/* Instruction */}
      <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
        {step.instruction}
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        {step.reads.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Reads:</span>
            {step.reads.map((r) => (
              <span key={r} className="pill" style={{ fontSize: 11, padding: '2px 8px' }}>
                {r}
              </span>
            ))}
          </div>
        )}

        {step.sources.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Sources:</span>
            {step.sources.map((src, i) => (
              <span key={i} className="pill pill-blue" style={{ fontSize: 11, padding: '2px 8px' }}>
                {sourceLabel(src)}
              </span>
            ))}
          </div>
        )}

        {depLabels.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontWeight: 500 }}>After:</span>
            {depLabels.map((l) => (
              <span key={l} className="pill pill-accent" style={{ fontSize: 11, padding: '2px 8px' }}>
                {l}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Output column name (editable) */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
          Output column
        </span>
        {editingKey ? (
          <input
            className="input"
            value={keyDraft}
            autoFocus
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setKeyDraft(step.output.key); setEditingKey(false); }
            }}
            style={{ fontSize: 12, padding: '4px 8px', flex: 1, minWidth: 0 }}
          />
        ) : (
          <>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--ink)',
                background: 'var(--surface-2)',
                padding: '2px 7px',
                borderRadius: 4,
                border: '1px solid var(--border)',
              }}
            >
              {step.output.key}
            </span>
            <button
              onClick={() => { setKeyDraft(step.output.key); setEditingKey(true); }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--muted)',
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 4,
                fontFamily: 'inherit',
              }}
            >
              Rename
            </button>
          </>
        )}
        <span className="pill pill-green" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto', flexShrink: 0 }}>
          New column
        </span>
      </div>
    </div>
  );
}

// ── DoggoSettingsSection ──────────────────────────────────────────────────────

function DoggoSettingsSection({
  open,
  onToggle,
  brainProvider,
  brainModel,
  defaultModel,
  webSearchOn,
  saving,
  onProvider,
  onModel,
  onWebSearch,
}: {
  open: boolean;
  onToggle: () => void;
  brainProvider: LLMProvider;
  brainModel: string;
  defaultModel: { provider: string; model: string } | null;
  webSearchOn: boolean;
  saving: boolean;
  onProvider: (p: LLMProvider) => void;
  onModel: (m: string) => void;
  onWebSearch: (on: boolean) => void;
}) {
  return (
    <div className="doggo-settings">
      <button type="button" className="doggo-settings-head" onClick={onToggle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▾' : '▸'}</span>
          Doggo settings
        </span>
        {saving && <span className="muted" style={{ fontSize: 11 }}>Saving…</span>}
      </button>
      {open && (
        <div className="doggo-settings-body">
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            The <strong>brain</strong> Doggo plans with and the <strong>default sources</strong> it gives
            the columns it builds. Saved on this table.
          </p>

          <div className="field" style={{ marginBottom: 0 }}>
            <label>Brain — provider</label>
            <select
              className="select"
              value={brainProvider}
              onChange={(e) => onProvider(e.target.value as LLMProvider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                  {defaultModel && defaultModel.provider === p.value ? ' (server default)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label>Brain — model</label>
            <input
              className="input"
              value={brainModel}
              onChange={(e) => onModel(e.target.value)}
              placeholder={defaultModel?.model ?? 'model id'}
            />
          </div>

          <label className="doggo-toggle">
            <input
              type="checkbox"
              checked={webSearchOn}
              onChange={(e) => onWebSearch(e.target.checked)}
            />
            <span>Web search for the columns Doggo creates (LLM is always on)</span>
          </label>
        </div>
      )}
    </div>
  );
}

// ── StepNumber ────────────────────────────────────────────────────────────────

function StepNumber({ n }: { n: number }) {
  return (
    <span
      style={{
        flexShrink: 0,
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: 'var(--ink)',
        color: '#fff',
        fontSize: 11,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {n}
    </span>
  );
}
