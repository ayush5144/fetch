'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { api } from '@/lib/api';

/** Create a single lead by hand — the same ingestion path as CSV, one row. */
export function AddLeadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', title: '', company: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/leads', form);
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy} onClick={submit}>
            {busy ? 'Adding…' : 'Add lead'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>First name</label>
          <input className="input" value={form.firstName} onChange={set('firstName')} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Last name</label>
          <input className="input" value={form.lastName} onChange={set('lastName')} />
        </div>
      </div>
      <div className="field">
        <label>Email</label>
        <input className="input" value={form.email} onChange={set('email')} placeholder="ava@acme.com" />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Title</label>
          <input className="input" value={form.title} onChange={set('title')} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Company</label>
          <input className="input" value={form.company} onChange={set('company')} />
        </div>
      </div>
      {err && <div className="pill pill-red">{err}</div>}
    </Modal>
  );
}
