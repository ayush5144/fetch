import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fetch — open-source, self-hostable Clay',
  description:
    'A multi-table workspace where a column is a reusable job and an AI agent fills any cell. Bring your own keys, self-host everything.',
};

/**
 * Root layout: just the document shell + fonts. The OS routes add their own
 * sidebar via the `(os)` route-group layout; the marketing landing at `/` has
 * none.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preconnect"
          href="https://rsms.me/"
        />
        <link
          rel="stylesheet"
          href="https://rsms.me/inter/inter.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
