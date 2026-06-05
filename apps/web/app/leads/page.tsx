'use client';

import { Suspense } from 'react';
import LeadsPageInner from './LeadsPageInner';

/**
 * Leads route — Suspense boundary so useSearchParams() works in Next.js
 * App Router without making the whole layout dynamic.
 */
export default function LeadsPage() {
  return (
    <Suspense fallback={<div className="content muted">Loading…</div>}>
      <LeadsPageInner />
    </Suspense>
  );
}
