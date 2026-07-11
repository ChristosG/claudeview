import { useEffect, useState, useCallback } from 'react';

export type Freshness = 'fresh' | 'stale' | 'broken' | 'contradicted';

const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export const post = (url: string, body?: unknown) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/**
 * Fetch, and re-fetch whenever the underlying data actually changes.
 *
 * The server watches the transcript files Claude Code is already writing, so the dashboard
 * updates *while you work* — with no polling, no hook, and no overhead added to the session
 * being observed. `revision` ticks on every SSE event; every hook re-runs.
 */
export function useLive<T>(url: string, revision: number): { data: T | undefined; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    j(url)
      .then((d) => !cancelled && (setData(d), setError(undefined)))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => { cancelled = true; };
  }, [url, revision, nonce]);

  return { data, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** One EventSource for the whole app. Every change to disk bumps `revision`. */
export function useStream(): { revision: number; connected: boolean } {
  const [revision, setRevision] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = () => setRevision((r) => r + 1);
    return () => es.close();
  }, []);

  return { revision, connected };
}
