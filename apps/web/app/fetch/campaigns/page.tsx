'use client';

import { useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { StatusPill } from '@/components/StatusPill';
import { Modal } from '@/components/Modal';
import { api, type Campaign } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Campaign builder + launcher. A campaign picks a provider (the send rail) and
 * eligibility rules; launching enqueues a send only for leads that clear the
 * validation + approval gates. Switching provider needs no other change — the
 * adapter layer owns the difference.
 */
export default function CampaignsPage() {
  const campaigns = useApi<{ campaigns: Campaign[] }>('/campaigns', 5000);
  const [open, setOpen] = useState(false);

  async function launch(id: string) {
    const res = await api.post<{ launched: number; reason?: string }>(`/campaigns/${id}/launch`);
    alert(res.launched ? `Launched ${res.launched} leads.` : `Nothing launched: ${res.reason}`);
    campaigns.refresh();
  }

  return (
    <>
      <Topbar
        title="Campaigns"
        subtitle="Define the rail and rules; the gate decides who's eligible."
        actions={
          <button className="btn btn-accent" onClick={() => setOpen(true)}>
            New campaign
          </button>
        }
      />
      <div className="content">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(campaigns.data?.campaigns ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="cell-strong">{c.name}</td>
                  <td>
                    <span className="pill pill-blue">
                      <span className="dot" />
                      {c.provider}
                    </span>
                  </td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                  <td className="muted">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => api.post(`/campaigns/${c.id}/personalize`).then(() => alert('Personalization queued.'))}
                      >
                        Personalize
                      </button>
                      <button className="btn btn-accent btn-sm" onClick={() => launch(c.id)}>
                        Launch
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {(campaigns.data?.campaigns ?? []).length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      <div className="empty-icon">✦</div>
                      No campaigns yet.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {open && <NewCampaignModal onClose={() => setOpen(false)} onDone={campaigns.refresh} />}
    </>
  );
}

function NewCampaignModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('instantly');
  const [allowRisky, setAllowRisky] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/campaigns', { name, provider, rules: { allowRisky, requireApproved: true } });
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New campaign"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !name} onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Send rail</label>
        <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="instantly">Instantly</option>
          <option value="smartlead">Smartlead</option>
          <option value="smtp">SMTP</option>
        </select>
      </div>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={allowRisky} onChange={(e) => setAllowRisky(e.target.checked)} />
        <span>Allow <span className="kbd">risky</span> leads (opt-in to the gate)</span>
      </label>
    </Modal>
  );
}
