'use client';

/**
 * AskDogiModal — Phase D "Goal mode" UI.
 *
 * Flow:
 *   1. User types a free-text goal and submits → POST /tables/:id/ask-dogi
 *   2. If plan is null, show the friendly reason.
 *   3. Otherwise show the plan review: ordered step cards.
 *      - Each card shows label, instruction, reads, output column name,
 *        sources, and dependencies.
 *      - Editable: rename output column key, remove a step.
 *   4. "Approve & build" → POST /tables/:id/apply-plan { steps }
 *      → closes modal, refreshes columns + leads, shows count of created columns.
 */

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  dogiApi,
  type DogiPlanStep,
  type DogiPlan,
} from '@/lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceLabel(source: DogiPlanStep['sources'][number]): string {
  switch (source.type) {
    case 'provider': return `Provider (${source.name})`;
    case 'web': return `Web search (${source.via})`;
    case 'scrape': return 'Scrape (Firecrawl)';
    case 'llm': return 'LLM';
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  tableId: string;
  onClose: () => void;
  /** Called after a successful apply-plan so the parent can refresh. */
  onDone: (columnsCreated: number) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AskDogiModal({ tableId, onClose, onDone }: Props) {
  // ── Phase 1: goal input
  const [goal, setGoal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Phase 2: plan review
  const [plan, setPlan] = useState<DogiPlan | null>(null);
  const [noLlmReason, setNoLlmReason] = useState<string | null>(null);

  // ── Editable steps (local copy so user can rename / remove)
  const [steps, setSteps] = useState<DogiPlanStep[]>([]);

  // ── Phase 3: applying
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleAskDogi() {
    if (!goal.trim()) return;
    setLoading(true);
    setError(null);
    setNoLlmReason(null);
    setPlan(null);
    try {
      const res = await dogiApi.askDogi(tableId, goal.trim());
      if (!res.plan) {
        setNoLlmReason(res.reason ?? 'No LLM is configured. Add an LLM key in your environment to use goal mode.');
      } else {
        setPlan(res.plan);
        setSteps(res.plan.steps.map((s) => ({ ...s, output: { ...s.output } })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function renameOutputKey(stepId: string, newKey: string) {
    setSteps((prev) =>
      prev.map((s) =>
        s.id === stepId
          ? { ...s, output: { ...s.output, key: newKey } }
          : s,
      ),
    );
  }

  function removeStep(stepId: string) {
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
  }

  async function handleApply() {
    if (steps.length === 0) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await dogiApi.applyPlan(tableId, steps);
      onDone(res.columnsCreated);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Failed to apply plan');
      setApplying(false);
    }
  }

  // ── Render: goal input phase ───────────────────────────────────────────────

  if (!plan) {
    return (
      <Modal
        title="Ask Dogi 🐕"
        onClose={onClose}
        maxWidth={520}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-accent btn-sm"
              disabled={!goal.trim() || loading}
              onClick={handleAskDogi}
            >
              {loading ? 'Planning…' : 'Ask Dogi'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6 }}>
            Describe what you want to learn or do with your leads. Dogi will plan the columns to build and fill them in order.
          </p>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Your goal</label>
            <textarea
              className="textarea"
              placeholder="e.g. Find the CEO's email, then write a custom cold email"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAskDogi();
              }}
              style={{ minHeight: 90, fontFamily: 'inherit', fontSize: 13 }}
              autoFocus
            />
            <span className="muted" style={{ fontSize: 12 }}>
              Plain language — no jargon needed. Press Cmd+Enter to submit.
            </span>
          </div>

          {noLlmReason && (
            <div
              style={{
                background: 'var(--amber-soft)',
                border: '1px solid var(--amber)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 14px',
                fontSize: 13,
                color: 'var(--amber)',
              }}
            >
              <strong>No LLM configured</strong>
              <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>{noLlmReason}</div>
            </div>
          )}

          {error && (
            <div
              style={{
                background: 'var(--red-soft)',
                border: '1px solid var(--red)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 14px',
                fontSize: 13,
                color: 'var(--red)',
              }}
            >
              {error}
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // ── Render: plan review phase ──────────────────────────────────────────────

  return (
    <Modal
      title="Review Dogi's plan 🐕"
      onClose={onClose}
      maxWidth={600}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setPlan(null); setSteps([]); }}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-accent btn-sm"
              disabled={steps.length === 0 || applying}
              onClick={handleApply}
            >
              {applying ? 'Building…' : `Approve & build (${steps.length} column${steps.length !== 1 ? 's' : ''})`}
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

        {/* Instruction */}
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Dogi will create {steps.length} column{steps.length !== 1 ? 's' : ''} and fill them in order. You can rename the output column key or remove a step before applying.
        </p>

        {/* Steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {steps.map((step, idx) => (
            <PlanStepCard
              key={step.id}
              step={step}
              index={idx}
              allSteps={steps}
              onRenameKey={(newKey) => renameOutputKey(step.id, newKey)}
              onRemove={() => removeStep(step.id)}
            />
          ))}
        </div>

        {steps.length === 0 && (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            All steps removed. Go back to ask again.
          </div>
        )}

        {applyError && (
          <div
            style={{
              background: 'var(--red-soft)',
              border: '1px solid var(--red)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              fontSize: 13,
              color: 'var(--red)',
            }}
          >
            {applyError}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── PlanStepCard ──────────────────────────────────────────────────────────────

interface StepCardProps {
  step: DogiPlanStep;
  index: number;
  allSteps: DogiPlanStep[];
  onRenameKey: (newKey: string) => void;
  onRemove: () => void;
}

function PlanStepCard({ step, index, allSteps, onRenameKey, onRemove }: StepCardProps) {
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

  // Find the labels for steps this one depends on
  const depLabels = step.dependsOn
    .map((depId) => {
      const depStep = allSteps.find((s) => s.id === depId);
      return depStep ? depStep.label : depId;
    })
    .filter(Boolean);

  return (
    <div
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {/* Step number */}
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
            {index + 1}
          </span>
          {/* Label */}
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {step.label}
          </span>
        </div>
        {/* Remove */}
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

        {/* Reads */}
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

        {/* Sources */}
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

        {/* Dependencies */}
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
