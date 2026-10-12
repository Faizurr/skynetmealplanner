import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { errorMessage } from '../lib/api';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
  action?: { label: string; onClick: () => void };
  sticky?: boolean;
}
interface ToastApi {
  show: (t: Omit<ToastItem, 'id'>) => number;
  success: (m: string) => void;
  error: (e: unknown) => void;
  info: (m: string) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = seq.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      if (!t.sticky) window.setTimeout(() => dismiss(id), t.kind === 'error' ? 7000 : 4000);
      return id;
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (m) => void show({ kind: 'success', message: m }),
      info: (m) => void show({ kind: 'info', message: m }),
      error: (e) => void show({ kind: 'error', message: typeof e === 'string' ? e : errorMessage(e) }),
    }),
    [show, dismiss],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {items.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info;
          return (
            <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
              <Icon className="lead" aria-hidden />
              <div className="toast-msg">{t.message}</div>
              {t.action && (
                <button type="button" className="toast-action" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>
                  {t.action.label}
                </button>
              )}
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
