import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { useRealtimeRefresh } from './realtime';

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** true while a background refetch is in flight (data still shown) */
  refreshing: boolean;
  reload: () => void;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

/**
 * Fetches data, refetches when `deps` change, and live-refreshes (debounced) when one of
 * `tables` changes on the server. Background refreshes keep showing the previous data.
 */
export function useQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: { tables?: readonly string[]; enabled?: boolean } = {}): QueryState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(opts.enabled !== false);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const ctrl = useRef<AbortController | null>(null);
  const hasData = useRef(false);
  const enabled = opts.enabled !== false;

  const run = useCallback(
    async (background: boolean) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      if (background && hasData.current) setRefreshing(true);
      else setLoading(true);
      try {
        const d = await fetcherRef.current(c.signal);
        if (c.signal.aborted) return;
        hasData.current = true;
        setDataState(d);
        setError(null);
      } catch (e) {
        if (c.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return;
        // Keep stale data on background failures; surface error otherwise.
        if (!background || !hasData.current) setError(errorMessage(e));
      } finally {
        if (!c.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    hasData.current = false;
    setDataState(undefined);
    void run(false);
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useRealtimeRefresh(enabled ? opts.tables : undefined, () => void run(true));

  const reload = useCallback(() => void run(hasData.current), [run]);
  const setData = useCallback((fn: (d: T | undefined) => T | undefined) => setDataState((d) => fn(d)), []);
  return { data, error, loading, refreshing, reload, setData };
}

/** Debounced value (for search boxes). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-renders every `ms` (for relative times and countdowns). */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    h();
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}
