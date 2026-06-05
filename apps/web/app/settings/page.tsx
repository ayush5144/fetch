'use client';

import { useEffect, useState } from 'react';
import { Topbar } from '@/components/Topbar';
import { settingsApi, type KeyStatus, type Settings } from '@/lib/api';

/**
 * Read-only key-status view. Keys live in the server's `.env` (self-hosted);
 * this page just reflects which integrations are configured so an operator can
 * see at a glance what's available — it never accepts or submits secrets.
 * Per-Dogi BYOK keys (entered in a column's Dogi config) are never stored
 * server-side and so never appear here.
 */

type KeyName = keyof KeyStatus;

const SECTIONS: { title: string; hint: string; keys: { key: KeyName; label: string }[] }[] = [
  {
    title: 'LLM providers',
    hint: 'The brains a Dogi column can use to reason and write.',
    keys: [
      { key: 'anthropic', label: 'Anthropic (Claude)' },
      { key: 'openai', label: 'OpenAI' },
      { key: 'gemini', label: 'Google Gemini' },
      { key: 'grok', label: 'xAI Grok' },
    ],
  },
  {
    title: 'Enrichment',
    hint: 'Data providers that find emails, titles, and company facts.',
    keys: [
      { key: 'apollo', label: 'Apollo' },
      { key: 'hunter', label: 'Hunter' },
      { key: 'findymail', label: 'Findymail' },
      { key: 'dropcontact', label: 'Dropcontact' },
    ],
  },
  {
    title: 'Agent tools',
    hint: 'Web search and scraping a Dogi agent can call.',
    keys: [
      { key: 'serper', label: 'Serper (web search)' },
      { key: 'firecrawl', label: 'Firecrawl (scrape)' },
    ],
  },
  {
    title: 'Send rails',
    hint: 'How approved messages leave the building.',
    keys: [
      { key: 'instantly', label: 'Instantly' },
      { key: 'smartlead', label: 'Smartlead' },
      { key: 'smtp', label: 'SMTP' },
    ],
  },
];

export default function SettingsPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    settingsApi
      .get()
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load settings');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <Topbar
        title="Settings"
        subtitle="Default model and which keys the server has configured."
      />
      <div className="content stack">
        {loading && !data ? (
          <div className="card">
            <div className="empty">Loading settings…</div>
          </div>
        ) : error ? (
          <div className="card">
            <div className="empty" style={{ color: 'var(--red)' }}>
              {error}
            </div>
          </div>
        ) : data ? (
          <>
            <div className="card">
              <div className="card-head">
                <h3>Default model</h3>
                <span className="pill pill-accent">
                  <span className="dot" />
                  {data.llm.provider}
                </span>
              </div>
              <div className="card-pad">
                <div className="settings-model">
                  <span className="muted">Model</span>
                  <span className="cell-mono cell-strong">{data.llm.model}</span>
                </div>
                <p className="settings-note">
                  Keys live in the server's <span className="kbd">.env</span> (self-hosted).
                  Per-Dogi <strong>BYOK</strong> keys can be entered in a column's Dogi config
                  and are never stored server-side. This page is read-only.
                </p>
              </div>
            </div>

            {SECTIONS.map((section) => (
              <div className="card" key={section.title}>
                <div className="card-head">
                  <h3>{section.title}</h3>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {section.hint}
                  </span>
                </div>
                <div className="card-pad" style={{ paddingTop: 0, paddingBottom: 4 }}>
                  {section.keys.map(({ key, label }) => (
                    <div className="settings-row" key={key}>
                      <span className="settings-row-label">{label}</span>
                      <KeyPill configured={data.keys[key]} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

/** Coral when configured, muted when not — matches the calm-pill convention. */
function KeyPill({ configured }: { configured: boolean }) {
  return (
    <span className={`pill ${configured ? 'pill-accent' : 'pill-muted'}`}>
      <span className="dot" />
      {configured ? 'Configured' : 'Not set'}
    </span>
  );
}
