import Link from 'next/link';

const GITHUB = 'https://github.com/ayush5144/fetch';

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Dogi — fills any cell',
    body: 'A configurable agent enriches one cell at a time using data providers, web search, scraping, or an LLM — with provenance on every value.',
  },
  {
    title: 'Bone — builds whole tables',
    body: 'The autonomous orchestrator sources rows and builds the columns to enrich them, turning a goal into a finished table.',
  },
  {
    title: 'Self-hostable & BYOK',
    body: 'Four LLM providers, your own keys. Run the whole stack yourself — keys are never persisted server-side or logged.',
  },
  {
    title: 'Own your data',
    body: 'One canonical record in Postgres as the single source of truth. No parallel tables, no vendor lock-in.',
  },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <section className="landing-inner landing-hero">
        <div className="landing-mark">Fetch 🐕</div>
        <h1 className="landing-title">Open-source, self-hostable Clay</h1>
        <p className="landing-tagline">A column is a reusable job. An AI agent fills every cell.</p>
        <p className="landing-lede">
          Fetch is a multi-table workspace where each column is a reusable job and a customizable
          agent. <strong>Dogi</strong> fills any cell with provenance; <strong>Bone</strong> builds
          whole tables on its own. Bring your own keys and self-host everything.
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

      <section className="landing-inner landing-features">
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
