'use client';

import { useState } from 'react';
import Link from 'next/link';

const GITHUB = 'https://github.com/ayush5144/fetch';

/** The landing nav links, reused by the inline (desktop) bar and the drawer. */
const LINKS: { href: string; label: string; external?: boolean }[] = [
  { href: '#features', label: 'Features' },
  { href: GITHUB, label: 'GitHub', external: true },
];

/**
 * Public landing navbar — a solid, sticky bar at every viewport. On wide screens
 * the links sit inline; below the mobile breakpoint they collapse into a
 * hamburger that opens a right-side drawer (with a dimmed backdrop). The
 * dashboard has its own sidebar and does not use this. Responsive rules live in
 * globals.css under `.landing-nav*` / `.landing-drawer*`.
 */
export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="landing-nav">
      <div className="landing-nav-inner">
        <Link href="/" className="landing-nav-brand" onClick={close}>
          Fetch
        </Link>

        {/* Inline links — shown on wide screens, hidden below the breakpoint. */}
        <nav className="landing-nav-links">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="landing-nav-link"
              {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}
            >
              {l.label}
            </a>
          ))}
        </nav>

        {/* Hamburger — shown only on small screens (CSS-gated). */}
        <button
          type="button"
          className="landing-nav-toggle"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {/* Mobile drawer + backdrop (rendered at all sizes; CSS hides on desktop). */}
      <div
        className={`landing-drawer-backdrop ${open ? 'is-open' : ''}`}
        onClick={close}
        aria-hidden
      />
      <nav className={`landing-drawer ${open ? 'is-open' : ''}`} aria-label="Menu">
        {LINKS.map((l) => (
          <a
            key={l.label}
            href={l.href}
            className="landing-drawer-link"
            onClick={close}
            {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
