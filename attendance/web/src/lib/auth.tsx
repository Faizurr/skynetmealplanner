import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onUnauthorized } from './api';
import type { Me, Permission } from './types';
import * as f from './format';

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('/api/auth/me');
      setMe(m);
      setError(null);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : 'Could not load your account');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => setMe(null));
    void refresh();
    return () => onUnauthorized(null);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setMe(null);
      window.location.hash = '#/';
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ me, loading, error, refresh, signOut, can: (p) => !!me?.permissions.includes(p) }),
    [me, loading, error, refresh, signOut],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Signed-in only: the current account (throws if signed out). */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('Not signed in');
  return me;
}

/** Formatters bound to the restaurant timezone. */
export function useFmt() {
  const me = useAuth().me;
  const tz = me?.restaurant.timezone ?? 'Asia/Kuala_Lumpur';
  return useMemo(
    () => ({
      tz,
      time: (v: string | null | undefined) => f.fmtTime(v, tz),
      date: (v: string | null | undefined) => f.fmtDate(v, tz),
      dateTime: (v: string | null | undefined) => f.fmtDateTime(v, tz),
      dayShort: (v: string | null | undefined) => f.fmtDayShort(v, tz),
      today: () => f.localYmd(new Date(), tz),
      ymdOf: (v: string | Date) => f.localYmd(v, tz),
      toIso: (ymd: string, hhmm: string) => f.zonedToIso(ymd, hhmm, tz),
      toInputs: (v: string | null | undefined) => f.isoToLocalInputs(v, tz),
    }),
    [tz],
  );
}
