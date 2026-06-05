'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * Minimal data hook: fetch a GET endpoint on mount, expose loading/error, and a
 * `refresh` to re-pull after an action. `pollMs` makes a view live (the table,
 * the job monitor, the inbox) without a manual refresh, matching the "table
 * goes live" requirement — polling is the no-extra-infra way to do it.
 */
export function useApi<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { data, error, loading, refresh };
}
