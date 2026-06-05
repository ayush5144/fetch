'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { api, type Column, type ValueType } from '@/lib/api';

/**
 * Two-step CSV import with column mapping.
 *
 * Step 1 — pick a CSV file. Posts it to POST /tables/:id/import/preview
 *   → { headers: string[], sample: Record<string,string> }
 *
 * Step 2 — a mapping table: for each CSV header, the operator chooses:
 *   • Map to existing column  (dropdown of table columns)
 *   • Create new column       (editable name + value-type picker)
 *   • Skip                    (ignore that CSV column)
 *
 * Defaults: if the table has no user columns every header defaults to
 * "Create new". Identity headers (email/name/company) default to "Map"
 * when a matching system column exists.
 *
 * Import: POST /tables/:id/leads/import { csv, mapping }.
 * Shows imported/merged counts then refreshes.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

type MappingAction = 'map' | 'create' | 'skip';

interface HeaderMapping {
  action: MappingAction;
  /** key of existing column to map to */
  key?: string;
  /** label for the new column */
  label: string;
  /** value type for the new column */
  valueType: ValueType;
}

const VALUE_TYPES: { id: ValueType; label: string; icon: string }[] = [
  { id: 'text',     label: 'Text',   icon: 'T'  },
  { id: 'email',    label: 'Email',  icon: '✉'  },
  { id: 'url',      label: 'URL',    icon: '🔗' },
  { id: 'number',   label: 'Number', icon: '#'  },
  { id: 'date',     label: 'Date',   icon: '📅' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Guess an initial mapping action + key for a CSV header */
function guessMapping(
  header: string,
  columns: Column[],
): Pick<HeaderMapping, 'action' | 'key' | 'valueType'> {
  if (columns.length === 0) {
    // No user columns yet — default to create
    return { action: 'create', valueType: guessValueType(header) };
  }
  // Try to find a matching system / user column by key or label
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  const identity: Record<string, string[]> = {
    email:     ['email'],
    firstName: ['firstname', 'first_name', 'first'],
    lastName:  ['lastname', 'last_name', 'last'],
    company:   ['company', 'organization', 'org'],
    title:     ['title', 'jobtitle', 'job_title', 'role'],
  };
  for (const col of columns) {
    const colNorm = col.key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = identity[col.key] ?? [];
    if (colNorm === h || aliases.includes(h)) {
      return { action: 'map', key: col.key, valueType: 'text' };
    }
  }
  return { action: 'create', valueType: guessValueType(header) };
}

function guessValueType(header: string): ValueType {
  const h = header.toLowerCase();
  if (h.includes('email')) return 'email';
  if (h.includes('url') || h.includes('website') || h.includes('link')) return 'url';
  if (h.includes('date') || h.includes('time') || h.includes('at')) return 'date';
  if (h.includes('count') || h.includes('size') || h.includes('num') || h.includes('year')) return 'number';
  return 'text';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImportModal({
  onClose,
  onDone,
  tableId,
  columns = [],
}: {
  onClose: () => void;
  onDone: () => void;
  tableId?: string;
  columns?: Column[];
}) {
  // ── Step 1 state
  const [step, setStep] = useState<1 | 2>(1);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // ── Step 2 state
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [mappings, setMappings] = useState<Record<string, HeaderMapping>>({});

  // ── Import result
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; merged: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── Step 1: pick file ──────────────────────────────────────────────────────

  async function onFile(file: File) {
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    setPreviewErr(null);
  }

  async function previewCsv() {
    if (!csv.trim()) return;
    setPreviewing(true);
    setPreviewErr(null);
    try {
      let previewHeaders: string[];
      let previewSample: Record<string, string>;

      if (tableId) {
        // POST to the preview endpoint
        const res = await api.post<{ headers: string[]; sample: Record<string, string> }>(
          `/tables/${tableId}/import/preview`,
          { csv },
        );
        previewHeaders = res.headers;
        previewSample = res.sample;
      } else {
        // Parse locally as a fallback (no tableId)
        const lines = csv.trim().split('\n');
        previewHeaders = lines[0]?.split(',').map((h) => h.trim().replace(/^"|"$/g, '')) ?? [];
        previewSample = {};
        if (lines[1]) {
          const vals = lines[1].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
          previewHeaders.forEach((h, i) => { previewSample[h] = vals[i] ?? ''; });
        }
      }

      setHeaders(previewHeaders);
      setSample(previewSample);

      // Build initial mappings
      const initial: Record<string, HeaderMapping> = {};
      for (const h of previewHeaders) {
        const guess = guessMapping(h, columns);
        initial[h] = {
          action: guess.action,
          key: guess.key,
          // Friendly default label: turn underscores/dashes to spaces, title-case
          label: h.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          valueType: guess.valueType,
        };
      }
      setMappings(initial);
      setStep(2);
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : 'Could not parse the CSV — please check the file.');
    } finally {
      setPreviewing(false);
    }
  }

  // ── Step 2: update a header's mapping ─────────────────────────────────────

  function setAction(header: string, action: MappingAction) {
    setMappings((prev) => ({ ...prev, [header]: { ...prev[header], action } }));
  }

  function setMapKey(header: string, key: string) {
    setMappings((prev) => ({ ...prev, [header]: { ...prev[header], key } }));
  }

  function setCreateLabel(header: string, label: string) {
    setMappings((prev) => ({ ...prev, [header]: { ...prev[header], label } }));
  }

  function setCreateValueType(header: string, valueType: ValueType) {
    setMappings((prev) => ({ ...prev, [header]: { ...prev[header], valueType } }));
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      // Build the mapping payload
      const mappingPayload: Record<string, {
        action: 'create' | 'map' | 'skip';
        key?: string;
        label?: string;
        type?: string;
        valueType?: string;
      }> = {};

      for (const [header, m] of Object.entries(mappings)) {
        if (m.action === 'skip') {
          mappingPayload[header] = { action: 'skip' };
        } else if (m.action === 'map') {
          mappingPayload[header] = { action: 'map', key: m.key };
        } else {
          mappingPayload[header] = {
            action: 'create',
            label: m.label,
            type: 'manual',
            valueType: m.valueType,
          };
        }
      }

      const endpoint = tableId ? `/tables/${tableId}/leads/import` : '/leads/import';
      const res = await api.post<{ imported: number; merged: number; total: number }>(
        endpoint,
        { csv, mapping: mappingPayload },
      );
      setResult(res);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Import failed — please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const mappedCount = Object.values(mappings).filter((m) => m.action !== 'skip').length;
  const skipCount   = Object.values(mappings).filter((m) => m.action === 'skip').length;

  return (
    <Modal
      title={step === 1 ? 'Import leads — choose file' : 'Import leads — map columns'}
      maxWidth={step === 2 ? 780 : 520}
      onClose={onClose}
      footer={
        step === 1 ? (
          <>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-accent"
              disabled={previewing || !csv.trim()}
              onClick={previewCsv}
            >
              {previewing ? 'Reading…' : 'Next: map columns →'}
            </button>
          </>
        ) : result ? (
          <button className="btn btn-accent" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <button
              className="btn btn-accent"
              disabled={busy}
              onClick={submit}
            >
              {busy
                ? 'Importing…'
                : `Import ${mappedCount} column${mappedCount !== 1 ? 's' : ''}`}
            </button>
          </>
        )
      }
    >
      {/* ── Step 1: File picker ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="import-step1">
          <div className="field">
            <label>CSV file</label>
            <input
              type="file"
              accept=".csv,text/csv"
              className="input"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
            {fileName && (
              <span className="muted" style={{ fontSize: 12 }}>{fileName}</span>
            )}
          </div>

          <div className="field">
            <label>Or paste CSV</label>
            <textarea
              className="textarea"
              placeholder={'first_name,last_name,email,company\nAva,Chen,ava@acme.com,Acme'}
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setPreviewErr(null); }}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              We&apos;ll detect the columns and let you map them to your table.
            </span>
          </div>

          {previewErr && (
            <div className="pill pill-red" style={{ marginTop: 4 }}>{previewErr}</div>
          )}
        </div>
      )}

      {/* ── Step 2: Column mapping ──────────────────────────────────────── */}
      {step === 2 && !result && (
        <div className="import-step2">
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-soft)' }}>
            We found <strong>{headers.length} column{headers.length !== 1 ? 's' : ''}</strong> in your file.
            Choose what to do with each one.
            {skipCount > 0 && (
              <span className="muted"> ({skipCount} will be skipped.)</span>
            )}
          </p>

          <div className="import-map-table">
            {/* Header row */}
            <div className="import-map-header">
              <div className="import-map-col-csv">CSV column</div>
              <div className="import-map-col-sample">Sample value</div>
              <div className="import-map-col-action">Action</div>
              <div className="import-map-col-detail">Details</div>
            </div>

            {/* One row per CSV header */}
            {headers.map((header) => {
              const m = mappings[header];
              if (!m) return null;
              return (
                <div key={header} className={`import-map-row ${m.action === 'skip' ? 'import-map-row-skipped' : ''}`}>
                  {/* CSV header name */}
                  <div className="import-map-col-csv">
                    <span className="import-map-header-pill">{header}</span>
                  </div>

                  {/* Sample value */}
                  <div className="import-map-col-sample">
                    <span className="muted" style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>
                      {sample[header] ? String(sample[header]).slice(0, 40) : '—'}
                    </span>
                  </div>

                  {/* Action selector */}
                  <div className="import-map-col-action">
                    <select
                      className="select"
                      value={m.action}
                      onChange={(e) => setAction(header, e.target.value as MappingAction)}
                      style={{ fontSize: 12, padding: '5px 8px' }}
                    >
                      {columns.length > 0 && (
                        <option value="map">Map to existing</option>
                      )}
                      <option value="create">Create new column</option>
                      <option value="skip">Skip</option>
                    </select>
                  </div>

                  {/* Detail — depends on action */}
                  <div className="import-map-col-detail">
                    {m.action === 'map' && (
                      <select
                        className="select"
                        value={m.key ?? ''}
                        onChange={(e) => setMapKey(header, e.target.value)}
                        style={{ fontSize: 12, padding: '5px 8px' }}
                      >
                        <option value="" disabled>Pick column…</option>
                        {columns.map((c) => (
                          <option key={c.key} value={c.key}>{c.label}</option>
                        ))}
                      </select>
                    )}
                    {m.action === 'create' && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          className="input"
                          value={m.label}
                          onChange={(e) => setCreateLabel(header, e.target.value)}
                          placeholder="Column name"
                          style={{ fontSize: 12, padding: '5px 8px', flex: 1 }}
                        />
                        <select
                          className="select"
                          value={m.valueType}
                          onChange={(e) => setCreateValueType(header, e.target.value as ValueType)}
                          style={{ fontSize: 12, padding: '5px 8px', width: 90, flexShrink: 0 }}
                        >
                          {VALUE_TYPES.map((vt) => (
                            <option key={vt.id} value={vt.id}>{vt.icon} {vt.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {m.action === 'skip' && (
                      <span className="muted" style={{ fontSize: 12 }}>Not imported</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {err && <div className="pill pill-red" style={{ marginTop: 12 }}>{err}</div>}
        </div>
      )}

      {/* ── Result ──────────────────────────────────────────────────────── */}
      {result && (
        <div style={{ padding: '8px 0' }}>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-soft)' }}>
            Import complete!
          </p>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill pill-green">
              <span className="dot" />
              {result.imported} imported
            </span>
            <span className="pill pill-muted">
              <span className="dot" />
              {result.merged} merged (deduped)
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
