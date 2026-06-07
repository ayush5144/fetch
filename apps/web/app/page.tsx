import Link from 'next/link';
import { LandingNav } from '@/components/LandingNav';

const GITHUB = 'https://github.com/ayush5144/fetch';

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Dogi - fills any cell',
    body: 'A configurable agent enriches one cell at a time using data providers, web search, scraping, or an LLM - with provenance on every value.',
  },
  {
    title: 'Bone - builds whole tables',
    body: 'The autonomous orchestrator sources rows and builds the columns to enrich them, turning a goal into a finished table.',
  },
  {
    title: 'Self-hostable & BYOK',
    body: 'Four LLM providers, your own keys. Run the whole stack yourself - keys are never persisted server-side or logged.',
  },
  {
    title: 'Own your data',
    body: 'One canonical record in Postgres as the single source of truth. No parallel tables, no vendor lock-in.',
  },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <LandingNav />
      <section className="landing-inner landing-hero">
        <span className="landing-eyebrow">Open source · self-hostable · bring your own keys</span>
        <h1 className="landing-title">The spreadsheet where every column is an AI agent</h1>
        <p className="landing-lede">
          Fetch is a multi-table workspace for research and outreach. Each column is a reusable
          job: <strong>Dogi</strong> fills any cell - with the sources behind every value - while{' '}
          <strong>Bone</strong> finds the rows and builds entire tables from a single goal. A
          self-hostable, open-source take on Clay.
        </p>
        <div className="landing-cta">
          <Link
            href="/fetch"
            className="btn btn-accent"
          >
            Open Fetch →
          </Link>
          <a
            href={GITHUB}
            className="btn btn-ghost"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </section>

      <section id="features" className="landing-inner landing-features">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="landing-card"
          >
            <h2 className="landing-card-title">{f.title}</h2>
            <p className="landing-card-body">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-inner landing-note">
        <h2 className="landing-note-title">A side project, built in the open</h2>
        <p className="landing-note-body">
          I&apos;m building Fetch as a side project - it grew out of a problem I kept running into
          and genuinely want to solve well. It&apos;s <strong>open source</strong>, and still under
          active development: useful, but <strong>not production-grade yet</strong>.
        </p>
        <p className="landing-note-body">
          Want to contribute, report a bug, or just say hi? Reach me at{' '}
          <a href="mailto:ayushpatil9977@gmail.com">ayushpatil9977@gmail.com</a>.
        </p>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <span className="landing-footer-sep">·</span>
          <a href="mailto:ayushpatil9977@gmail.com">ayushpatil9977@gmail.com</a>
          <span className="landing-footer-spacer" />
          <span>MIT licensed</span>
          <span className="landing-footer-sep">·</span>
          <span>© 2026 Fetch</span>
        </div>
      </footer>
    </div>
  );
}
