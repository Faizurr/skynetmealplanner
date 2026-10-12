import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type RealtimeTable = 'attendance_events' | 'attendance_sessions' | 'attendance_exceptions' | 'devices' | 'employees' | 'face_enrollments';
export interface ChangeMsg {
  table: RealtimeTable | string;
  op: string;
  id: string;
}
type Listener = (msg: ChangeMsg | null) => void; // null = (re)connected; refetch everything

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'off';

interface RealtimeApi {
  state: ConnState;
  subscribe: (l: Listener) => () => void;
}

const Ctx = createContext<RealtimeApi>({ state: 'off', subscribe: () => () => {} });

/** One shared EventSource for the whole app (mounted only when signed in). */
export function RealtimeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, setState] = useState<ConnState>(enabled ? 'connecting' : 'off');
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setState('off');
      return;
    }
    let es: EventSource | null = null;
    let everConnected = false;
    let closed = false;
    let retryTimer: number | undefined;
    const emit = (m: ChangeMsg | null) => listeners.current.forEach((l) => l(m));
    const open = () => {
      if (closed) return;
      es = new EventSource('/api/stream', { withCredentials: true });
      es.addEventListener('ready', () => {
        setState('live');
        // After a reconnect we may have missed changes: refresh visible views.
        if (everConnected) emit(null);
        everConnected = true;
      });
      es.addEventListener('change', (ev) => {
        try {
          emit(JSON.parse((ev as MessageEvent<string>).data) as ChangeMsg);
        } catch {
          /* ignore malformed */
        }
      });
      es.onerror = () => {
        setState('reconnecting');
        // The browser retries automatically unless the stream was closed for good (e.g. 401).
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          retryTimer = window.setTimeout(open, 5000);
        }
      };
    };
    setState('connecting');
    open();
    const onOnline = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        window.clearTimeout(retryTimer);
        open();
      }
    };
    window.addEventListener('online', onOnline);
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', onOnline);
      es?.close();
    };
  }, [enabled]);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => {
      listeners.current.delete(l);
    };
  }, []);
  const value = useMemo(() => ({ state, subscribe }), [state, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeApi {
  return useContext(Ctx);
}

/** Calls `fn` (debounced) whenever one of `tables` changes, or after a reconnect. */
export function useRealtimeRefresh(tables: readonly string[] | undefined, fn: () => void, delay = 300) {
  const { subscribe } = useRealtime();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = tables?.join(',') ?? '';
  useEffect(() => {
    if (!key) return undefined;
    const set = new Set(key.split(','));
    let t: number | undefined;
    const unsub = subscribe((m) => {
      if (m && !set.has(m.table)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => fnRef.current(), delay);
    });
    return () => {
      window.clearTimeout(t);
      unsub();
    };
  }, [key, subscribe, delay]);
}
