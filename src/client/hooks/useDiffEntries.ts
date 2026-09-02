import { useCallback, useEffect, useState } from 'react';

import type { DiffEntrySummary, DiffsResponse } from '../../types/diff';

const REFRESH_INTERVAL_MS = 30_000;
const ELAPSED_TICK_MS = 60_000;

interface UseDiffEntriesResult {
  diffs: DiffEntrySummary[];
  activeDiffId: string | null;
  /** Ticks every minute so elapsed-time labels stay current. */
  now: number;
}

/**
 * Tracks the diffs hosted by the server. Polls instead of subscribing: the list
 * changes rarely, and the elapsed labels need a periodic re-render anyway.
 */
export function useDiffEntries(): UseDiffEntriesResult {
  const [diffs, setDiffs] = useState<DiffEntrySummary[]>([]);
  const [activeDiffId, setActiveDiffId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/diffs');
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as DiffsResponse;
      setDiffs(Array.isArray(data.diffs) ? data.diffs : []);
      setActiveDiffId(typeof data.activeDiffId === 'string' ? data.activeDiffId : null);
    } catch {
      // The static site build has no diff registry; leave the switcher hidden.
    }
  }, []);

  useEffect(() => {
    void refresh();

    const refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const elapsedTimer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    const handleFocus = () => {
      setNow(Date.now());
      void refresh();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(elapsedTimer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refresh]);

  return { diffs, activeDiffId, now };
}
