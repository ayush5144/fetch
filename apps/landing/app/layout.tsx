import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fetch — open-source, self-hostable Clay',
  description:
    'A multi-table workspace where a column is a reusable job and an AI agent fills any cell. Bring your own keys, self-host everything.',
};

/**
 * Root layout for the standalone marketing landing. This app is just the public
 * landing page (deployed on its own); the full Fetch OS lives in `apps/web`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://rsms.me/" />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
