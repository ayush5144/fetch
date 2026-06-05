'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The left navigation. Table-first product, so Leads sits at the top; the rest
 * are the operator surfaces from the architecture (accounts, campaigns,
 * prompts, jobs, inbox, analytics).
 */
const NAV: { group: string; items: { href: string; label: string; ico: string }[] }[] = [
  {
    group: 'Workspace',
    items: [
      { href: '/', label: 'Overview', ico: '◈' },
      { href: '/leads', label: 'Leads', ico: '☰' },
      { href: '/accounts', label: 'Accounts', ico: '◇' },
    ],
  },
  {
    group: 'Outreach',
    items: [
      { href: '/campaigns', label: 'Campaigns', ico: '✦' },
      { href: '/prompts', label: 'Prompts', ico: '✎' },
      { href: '/inbox', label: 'Reply inbox', ico: '✉' },
    ],
  },
  {
    group: 'System',
    items: [
      { href: '/jobs', label: 'Job monitor', ico: '⚙' },
      { href: '/analytics', label: 'Analytics', ico: '▦' },
    ],
  },
];

export function Sidebar() {
  const path = usePathname();
  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

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
