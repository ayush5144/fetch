'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const GITHUB = 'https://github.com/ayush5144/fetch';

/**
 * Floating, scroll-aware navbar for the public landing page (the dashboard has
 * its own sidebar). Transparent at the top; gains a card background + hairline +
 * soft shadow once the page scrolls — on Fetch's tokens (navy ink, coral accent).
 */
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`landing-nav ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="landing-nav-pill">
        <Link href="/" className="landing-nav-brand">
          Fetch <span aria-hidden>🐕</span>
        </Link>
        <nav className="landing-nav-links">
          <a href="#features" className="landing-nav-link">
            Features
          </a>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="landing-nav-link">
            GitHub
          </a>
          <Link href="/fetch" className="btn btn-accent btn-sm">
            Open Fetch →
          </Link>
        </nav>
      </div>
    </header>
  );
}
