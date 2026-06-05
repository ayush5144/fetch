'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { api } from '@/lib/api';

/**
 * CSV import. Reads the file in the browser and posts the text to /leads/import,
 * which normalizes + dedupes server-side. We surface the imported/merged counts
 * so the operator sees dedupe working (re-importing the same file merges, never
 * duplicates).
 */
export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; merged: number; total: number } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  async function onFile(file: File) {
    setName(file.name);
    setCsv(await file.text());
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ imported: number; merged: number; total: number }>(
        '/leads/import',
        { csv },
      );
      setResult(res);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'import failed');
    } finally {
      setBusy(false);
    }
  }

  const sample = 'first_name,last_name,email,company,title\nAva,Chen,ava@acme.com,Acme,VP Sales';

  return (
    <Modal
      title="Import leads"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-accent" disabled={busy || !csv} onClick={submit}>
            {busy ? 'Importing…' : 'Import CSV'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>CSV file</label>
        <input
          type="file"
          accept=".csv,text/csv"
          className="input"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        {name && <span className="muted" style={{ fontSize: 12 }}>{name}</span>}
      </div>

      <div className="field">
        <label>Or paste CSV</label>
        <textarea
          className="textarea"
          placeholder={sample}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Headers like name, email, company, title are detected automatically. Unknown columns
          become user columns.
        </span>
      </div>

      {result && (
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
      )}
      {err && <div className="pill pill-red">{err}</div>}
    </Modal>
  );
}
