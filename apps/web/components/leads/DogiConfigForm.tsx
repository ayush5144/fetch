'use client';

/**
 * DogiConfigForm — full Dogi configuration form.
 *
 * Covers the complete cell-Dogi schema from dogi-agent.md §9:
 *   instruction, reads, output, sources, policy, brain (provider/model/keySource).
 *
 * Brain only appears when at least one LLM-needing source is enabled
 * (web search, scrape, or LLM). Data-provider-only Dogis need no brain.
 *
 * BYOK key is held in state only, never persisted — the parent passes it
 * through `onApiKeyChange` and includes it in run requests only.
 *
 * Phase E: `onSaveAsAgent` — optional callback. When provided, a "Save as agent"
 * button appears at the bottom of the form. The parent handles the API call.
 */

import { useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

export type DogiOutputMode = 'fill' | 'create' | 'map';

export interface DogiOutput {
  mode: DogiOutputMode;
  key?: string;   // column key for "map" or "create"
  label?: string; // human label for "create"
}

export type DataProviderName = 'apollo' | 'hunter';
export type WebSearchVia = 'native' | 'external';

export interface DogiSourceProvider {
  type: 'provider';
  name: DataProviderName;
}
export interface DogiSourceWeb {
  type: 'web';
  via: WebSearchVia;
}
export interface DogiSourceScrape {
  type: 'scrape';
  via: 'firecrawl';
}
export interface DogiSourceLLM {
  type: 'llm';
}
export type DogiSource =
  | DogiSourceProvider
  | DogiSourceWeb
  | DogiSourceScrape
  | DogiSourceLLM;

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'grok';
export type KeySource = 'env' | 'byok';

export interface DogiBrain {
  provider: LLMProvider;
  model: string;
  keySource: KeySource;
}

export interface DogiConfig {
  instruction: string;
  reads: string[];
  output: DogiOutput;
  sources: DogiSource[];
  policy: 'combine' | 'first';
  brain?: DogiBrain;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DATA_PROVIDERS: { value: DataProviderName; label: string }[] = [
  { value: 'apollo', label: 'Apollo' },
  { value: 'hunter', label: 'Hunter' },
];

const LLM_PROVIDERS: {
  value: LLMProvider;
  label: string;
  models: { value: string; label: string }[];
}[] = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    models: [
      { value: 'claude-opus-4-8', label: 'Claude Opus 4' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { value: 'claude-haiku-3-5', label: 'Claude Haiku 3.5' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: [
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-search-preview', label: 'GPT-4o (web search)' },
      { value: 'gpt-4o-mini-search-preview', label: 'GPT-4o mini (web search)' },
    ],
  },
  {
    value: 'gemini',
    label: 'Gemini',
    models: [
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    value: 'grok',
    label: 'Grok',
    models: [
      { value: 'grok-4', label: 'Grok 4' },
      { value: 'grok-3', label: 'Grok 3' },
    ],
  },
];

const DEFAULT_BRAIN: DogiBrain = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keySource: 'env',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function needsBrain(sources: DogiSource[]): boolean {
  return sources.some(
    (s) => s.type === 'web' || s.type === 'scrape' || s.type === 'llm',
  );
}

function hasProvider(sources: DogiSource[]): boolean {
  return sources.some((s) => s.type === 'provider');
}

function getProviderSource(sources: DogiSource[]): DogiSourceProvider | undefined {
  return sources.find((s): s is DogiSourceProvider => s.type === 'provider');
}

function getWebSource(sources: DogiSource[]): DogiSourceWeb | undefined {
  return sources.find((s): s is DogiSourceWeb => s.type === 'web');
}

function hasScrape(sources: DogiSource[]): boolean {
  return sources.some((s) => s.type === 'scrape');
}

function hasLLM(sources: DogiSource[]): boolean {
  return sources.some((s) => s.type === 'llm');
}

// ── Props ──────────────────────────────────────────────────────────────────────

/**
 * Backend availability for the web-search (external) and scrape sources, from
 * `GET /settings.search`. When a backend is down the matching toggle is gated
 * (disabled + an inline hint). Optional — when omitted, nothing is gated
 * (non-blocking: never assume unavailable if we couldn't fetch settings).
 */
export interface SearchAvailability {
  /** External web search (OpenSERP / Serper) is reachable. */
  webSearch: boolean;
  /** Scrape backend (self-hosted / hosted Firecrawl) is reachable. */
  scrape: boolean;
}

interface Props {
  value: DogiConfig;
  onChange: (v: DogiConfig) => void;
  availableColumns?: { key: string; label: string }[];
  /**
   * Web-search / scrape backend availability. When the relevant backend is
   * unavailable the matching toggle is disabled with an inline hint. `web:native`
   * is never gated (it needs no backend). Omit to leave everything enabled.
   */
  availability?: SearchAvailability;
  /** BYOK key — kept in parent state, never persisted */
  apiKey?: string;
  onApiKeyChange?: (key: string) => void;
  /**
   * Phase E — when provided, a "Save as agent" button is shown.
   * The callback receives the name the user chose and should call the API.
   */
  onSaveAsAgent?: (name: string) => Promise<void>;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DogiConfigForm({
  value,
  onChange,
  availableColumns = [],
  availability,
  apiKey = '',
  onApiKeyChange,
  onSaveAsAgent,
}: Props) {
  // When availability is unknown (undefined), don't gate anything — non-blocking.
  const webSearchDown = availability ? !availability.webSearch : false;
  const scrapeDown = availability ? !availability.scrape : false;
  // Phase E — save-as-agent state
  const [savingAgent, setSavingAgent] = useState(false);
  const [saveAgentName, setSaveAgentName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveAgentErr, setSaveAgentErr] = useState<string | null>(null);
  const [saveAgentOk, setSaveAgentOk] = useState(false);

  const brainRequired = needsBrain(value.sources);

  // Ensure brain is present when needed
  const brain = value.brain ?? DEFAULT_BRAIN;

  function setField<K extends keyof DogiConfig>(k: K, v: DogiConfig[K]) {
    onChange({ ...value, [k]: v });
  }

  // ── Source toggles ──────────────────────────────────────────────────────────

  function toggleProvider(on: boolean) {
    if (on) {
      // Add default provider source
      const next: DogiSource[] = [
        ...value.sources.filter((s) => s.type !== 'provider'),
        { type: 'provider', name: 'apollo' },
      ];
      onChange({ ...value, sources: next });
    } else {
      onChange({ ...value, sources: value.sources.filter((s) => s.type !== 'provider') });
    }
  }

  function setProviderName(name: DataProviderName) {
    const next = value.sources.map((s) =>
      s.type === 'provider' ? { ...s, name } : s,
    ) as DogiSource[];
    onChange({ ...value, sources: next });
  }

  function toggleWeb(on: boolean) {
    if (on) {
      const next: DogiSource[] = [
        ...value.sources.filter((s) => s.type !== 'web'),
        { type: 'web', via: 'native' },
      ];
      const nextBrain = value.brain ?? DEFAULT_BRAIN;
      onChange({ ...value, sources: next, brain: nextBrain });
    } else {
      const next = value.sources.filter((s) => s.type !== 'web');
      onChange({
        ...value,
        sources: next,
        brain: needsBrain(next) ? value.brain : undefined,
      });
    }
  }

  function setWebVia(via: WebSearchVia) {
    const next = value.sources.map((s) =>
      s.type === 'web' ? { ...s, via } : s,
    ) as DogiSource[];
    onChange({ ...value, sources: next });
  }

  function toggleScrape(on: boolean) {
    if (on) {
      const next: DogiSource[] = [
        ...value.sources.filter((s) => s.type !== 'scrape'),
        { type: 'scrape', via: 'firecrawl' },
      ];
      const nextBrain = value.brain ?? DEFAULT_BRAIN;
      onChange({ ...value, sources: next, brain: nextBrain });
    } else {
      const next = value.sources.filter((s) => s.type !== 'scrape');
      onChange({
        ...value,
        sources: next,
        brain: needsBrain(next) ? value.brain : undefined,
      });
    }
  }

  function toggleLLM(on: boolean) {
    if (on) {
      const next: DogiSource[] = [
        ...value.sources.filter((s) => s.type !== 'llm'),
        { type: 'llm' },
      ];
      const nextBrain = value.brain ?? DEFAULT_BRAIN;
      onChange({ ...value, sources: next, brain: nextBrain });
    } else {
      const next = value.sources.filter((s) => s.type !== 'llm');
      onChange({
        ...value,
        sources: next,
        brain: needsBrain(next) ? value.brain : undefined,
      });
    }
  }

  // ── Brain ───────────────────────────────────────────────────────────────────

  function setBrainProvider(provider: LLMProvider) {
    const providerDef = LLM_PROVIDERS.find((p) => p.value === provider)!;
    onChange({
      ...value,
      brain: {
        provider,
        model: providerDef.models[0].value,
        keySource: brain.keySource,
      },
    });
  }

  function setBrainModel(model: string) {
    onChange({ ...value, brain: { ...brain, model } });
  }

  function setBrainKeySource(keySource: KeySource) {
    onChange({ ...value, brain: { ...brain, keySource } });
    if (keySource === 'env' && onApiKeyChange) onApiKeyChange('');
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  function setOutputMode(mode: DogiOutputMode) {
    onChange({ ...value, output: { mode, key: value.output?.key, label: value.output?.label } });
  }

  const providerSource = getProviderSource(value.sources);
  const webSource = getWebSource(value.sources);
  const providerModels =
    LLM_PROVIDERS.find((p) => p.value === brain.provider)?.models ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Instruction ─────────────────────────────────────────────────────── */}
      <div className="field" style={{ marginBottom: 0 }}>
        <label>What should Dogi do?</label>
        <textarea
          className="textarea"
          placeholder="e.g. Find this company's CEO email address."
          value={value.instruction}
          onChange={(e) => setField('instruction', e.target.value)}
          style={{ minHeight: 68, fontFamily: 'inherit', fontSize: 13 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Plain language — no jargon needed.
        </span>
      </div>

      {/* ── Reads from ──────────────────────────────────────────────────────── */}
      {availableColumns.length > 0 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Reads from</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {availableColumns.map((col) => {
              const checked = value.reads.includes(col.key);
              return (
                <button
                  key={col.key}
                  type="button"
                  className={`pill ${checked ? 'pill-accent' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const next = checked
                      ? value.reads.filter((k) => k !== col.key)
                      : [...value.reads, col.key];
                    setField('reads', next);
                  }}
                >
                  {col.label}
                </button>
              );
            })}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Columns Dogi can see when filling each cell.
          </span>
        </div>
      )}

      {/* ── Output mapping ──────────────────────────────────────────────────── */}
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Output</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
            <input
              type="radio"
              name="dogi-output-mode"
              checked={!value.output?.mode || value.output.mode === 'fill'}
              onChange={() => setOutputMode('fill')}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            Fill this column
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
            <input
              type="radio"
              name="dogi-output-mode"
              checked={value.output?.mode === 'map'}
              onChange={() => setOutputMode('map')}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            Map to existing column
          </label>
          {value.output?.mode === 'map' && availableColumns.length > 0 && (
            <select
              className="select"
              value={value.output?.key ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  output: { mode: 'map', key: e.target.value },
                })
              }
              style={{ fontSize: 13, marginLeft: 24 }}
            >
              <option value="">Pick a column…</option>
              {availableColumns.map((col) => (
                <option key={col.key} value={col.key}>
                  {col.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ── Sources ─────────────────────────────────────────────────────────── */}
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Where should Dogi look?</label>
        <span className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          All optional. Turn on as many as you like.
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Data provider */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
              <input
                type="checkbox"
                checked={hasProvider(value.sources)}
                onChange={(e) => toggleProvider(e.target.checked)}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer', width: 14, height: 14 }}
              />
              <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Data provider</strong>
              <span className="muted" style={{ fontSize: 12 }}>— structured lookup (Apollo, Hunter)</span>
            </label>
            {hasProvider(value.sources) && (
              <div style={{ marginLeft: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Provider:</span>
                <select
                  className="select"
                  value={providerSource?.name ?? 'apollo'}
                  onChange={(e) => setProviderName(e.target.value as DataProviderName)}
                  style={{ fontSize: 12, padding: '5px 8px', width: 'auto', minWidth: 110 }}
                >
                  {DATA_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <span className="muted" style={{ fontSize: 11 }}>one at a time for now</span>
              </div>
            )}
          </div>

          {/* Web search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
              <input
                type="checkbox"
                checked={getWebSource(value.sources) !== undefined}
                onChange={(e) => toggleWeb(e.target.checked)}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer', width: 14, height: 14 }}
              />
              <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Web search</strong>
              <span className="muted" style={{ fontSize: 12 }}>— search the web</span>
            </label>
            {webSource && (
              <div style={{ marginLeft: 22, display: 'flex', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--ink-soft)', fontWeight: 400 }}>
                  <input
                    type="radio"
                    name="dogi-web-via"
                    checked={webSource.via === 'native'}
                    onChange={() => setWebVia('native')}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  Native (AI&apos;s own search)
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: webSearchDown ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    color: webSearchDown ? 'var(--muted)' : 'var(--ink-soft)',
                    fontWeight: 400,
                  }}
                >
                  <input
                    type="radio"
                    name="dogi-web-via"
                    checked={webSource.via === 'external'}
                    disabled={webSearchDown}
                    onChange={() => setWebVia('external')}
                    style={{ accentColor: 'var(--accent)', cursor: webSearchDown ? 'not-allowed' : 'pointer' }}
                  />
                  External (OpenSERP / Serper)
                </label>
              </div>
            )}
            {webSource && webSource.via === 'external' && webSearchDown && (
              <div className="dogi-source-hint" style={{ marginLeft: 22 }}>
                Web-search backend not running — see Settings. Native search still works.
              </div>
            )}
          </div>

          {/* Scrape */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: scrapeDown && !hasScrape(value.sources) ? 'not-allowed' : 'pointer',
                fontWeight: 400,
                fontSize: 13,
                color: scrapeDown ? 'var(--muted)' : 'var(--ink-soft)',
              }}
            >
              <input
                type="checkbox"
                checked={hasScrape(value.sources)}
                disabled={scrapeDown && !hasScrape(value.sources)}
                onChange={(e) => toggleScrape(e.target.checked)}
                style={{
                  accentColor: 'var(--accent)',
                  cursor: scrapeDown && !hasScrape(value.sources) ? 'not-allowed' : 'pointer',
                  width: 14,
                  height: 14,
                }}
              />
              <strong style={{ color: scrapeDown ? 'var(--muted)' : 'var(--ink)', fontWeight: 600 }}>Scrape</strong>
              <span className="muted" style={{ fontSize: 12 }}>— read a specific page (Firecrawl)</span>
            </label>
            {scrapeDown && (
              <div className="dogi-source-hint" style={{ marginLeft: 22 }}>
                Scrape backend not running — see Settings.
              </div>
            )}
          </div>

          {/* LLM */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
            <input
              type="checkbox"
              checked={hasLLM(value.sources)}
              onChange={(e) => toggleLLM(e.target.checked)}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer', width: 14, height: 14 }}
            />
            <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>LLM</strong>
            <span className="muted" style={{ fontSize: 12 }}>— reason or transform with AI</span>
          </label>

        </div>
      </div>

      {/* ── Policy ──────────────────────────────────────────────────────────── */}
      {value.sources.length > 1 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>When sources disagree</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
              <input
                type="radio"
                name="dogi-policy"
                checked={value.policy === 'combine'}
                onChange={() => setField('policy', 'combine')}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer', marginTop: 2 }}
              />
              <span>
                <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Use all sources and combine</strong>
                <span className="muted" style={{ fontSize: 12, display: 'block' }}>
                  Every source runs; results are merged for the richest answer. Costs more.
                </span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
              <input
                type="radio"
                name="dogi-policy"
                checked={value.policy === 'first'}
                onChange={() => setField('policy', 'first')}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer', marginTop: 2 }}
              />
              <span>
                <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Stop at the first answer</strong>
                <span className="muted" style={{ fontSize: 12, display: 'block' }}>
                  Sources try in order; stops as soon as one is confident. Cheaper.
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {/* ── Brain (only when LLM-needing source is on) ──────────────────────── */}
      {brainRequired && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            AI model
          </div>

          {/* Provider + Model row */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 120px', minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Provider</div>
              <select
                className="select"
                value={brain.provider}
                onChange={(e) => setBrainProvider(e.target.value as LLMProvider)}
                style={{ fontSize: 12, padding: '5px 8px' }}
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '2 1 150px', minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Model</div>
              <select
                className="select"
                value={brain.model}
                onChange={(e) => setBrainModel(e.target.value)}
                style={{ fontSize: 12, padding: '5px 8px' }}
              >
                {providerModels.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Key source */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>API key</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
                <input
                  type="radio"
                  name="dogi-key-source"
                  checked={brain.keySource === 'env'}
                  onChange={() => setBrainKeySource('env')}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                Use server key (recommended for self-hosted)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>
                <input
                  type="radio"
                  name="dogi-key-source"
                  checked={brain.keySource === 'byok'}
                  onChange={() => setBrainKeySource('byok')}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                Bring my own key
              </label>
              {brain.keySource === 'byok' && (
                <div style={{ marginLeft: 22 }}>
                  <input
                    className="input"
                    type="password"
                    placeholder="sk-… or API key"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange?.(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    autoComplete="off"
                  />
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    Used for this session only — never saved.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Save as agent (Phase E) ─────────────────────────────────────── */}
      {onSaveAsAgent && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
          {!showSaveInput ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 12 }}
              onClick={() => { setShowSaveInput(true); setSaveAgentErr(null); setSaveAgentOk(false); }}
            >
              ＋ Save as agent…
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Save as agent
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="input"
                  placeholder="Agent name, e.g. Find CEO email"
                  value={saveAgentName}
                  onChange={(e) => { setSaveAgentName(e.target.value); setSaveAgentErr(null); }}
                  style={{ fontSize: 12, flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSaveAgent();
                    }
                    if (e.key === 'Escape') {
                      setShowSaveInput(false);
                      setSaveAgentName('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-accent btn-sm"
                  disabled={savingAgent || !saveAgentName.trim()}
                  onClick={handleSaveAgent}
                  style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  {savingAgent ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setShowSaveInput(false); setSaveAgentName(''); setSaveAgentErr(null); }}
                  style={{ fontSize: 12 }}
                >
                  ✕
                </button>
              </div>
              {saveAgentErr && (
                <div style={{ fontSize: 11, color: 'var(--red)' }}>{saveAgentErr}</div>
              )}
              {saveAgentOk && (
                <div style={{ fontSize: 11, color: 'var(--green)' }}>Saved! You can reuse this agent when adding a column.</div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );

  async function handleSaveAgent() {
    if (!saveAgentName.trim() || !onSaveAsAgent) return;
    setSavingAgent(true);
    setSaveAgentErr(null);
    try {
      await onSaveAsAgent(saveAgentName.trim());
      setSaveAgentOk(true);
      setSaveAgentName('');
      setShowSaveInput(false);
      // Re-show success briefly
      setTimeout(() => setSaveAgentOk(false), 3000);
    } catch (e) {
      setSaveAgentErr(e instanceof Error ? e.message : 'Failed to save agent');
    } finally {
      setSavingAgent(false);
    }
  }
}
