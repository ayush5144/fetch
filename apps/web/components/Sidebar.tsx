'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The left navigation. Table-first product, so the workspace (Overview +
 * Tables) sits at the top, then Dogi (saved agents + key settings), the
 * outreach surfaces, and the system monitors. The standalone Accounts page is
 * folded away from the headline nav (the route still exists) per
 * devx/dedupe-and-accounts.md §3.
 */
const NAV: { group: string; items: { href: string; label: string; ico: string }[] }[] = [
  {
    group: 'Workspace',
    items: [
      { href: '/fetch', label: 'Overview', ico: '◈' },
      { href: '/leads', label: 'Tables', ico: '☰' },
    ],
  },
  {
    group: 'Dogi',
    items: [
      { href: '/agents', label: 'Agents', ico: '🐕' },
      { href: '/settings', label: 'Settings', ico: '⚙' },
    ],
  },
  {
    group: 'Outreach',
    items: [
      { href: '/campaigns', label: 'Campaigns', ico: '✦' },
      { href: '/prompts', label: 'Prompts', ico: '✎' },
      { href: '/inbox', label: 'Reply inbox', ico: '@' },
    ],
  },
  {
    group: 'System',
    items: [
      { href: '/jobs', label: 'Job monitor', ico: '◷' },
      { href: '/activity', label: 'Activity', ico: '≡' },
      { href: '/analytics', label: 'Analytics', ico: '▦' },
    ],
  },
];

export function Sidebar() {
  const path = usePathname();
  const isActive = (href: string) => (href === '/fetch' ? path === '/fetch' : path.startsWith(href));

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">F</div>
        <span className="brand-name">Fetch</span>
      </div>
      {NAV.map((section) => (
        <div key={section.group}>
          <div className="nav-label">{section.group}</div>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${isActive(item.href) ? 'active' : ''}`}
            >
              <span className="ico">{item.ico}</span>
              {item.label}
            </Link>
          ))}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div className="pill" style={{ justifyContent: 'center' }}>
        <span className="dot" />
        Self-hosted
      </div>
    </aside>
  );
}
