import { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useFmt } from '../../lib/auth';
import type { AuditEntry } from '../../lib/types';
import { Button, Card, EmptyState, ErrorState, SkeletonRows } from '../../components/ui';
import { SubPage } from './Settings';

const PAGE = 50;

function actionLabel(a: string): string {
  const s = a.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
    .join(' · ');
}

export function AuditLog() {
  const fmt = useFmt();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (before?: AuditEntry['id']) => {
    if (before) setMore(true);
    else setLoading(true);
    try {
      const r = await api.get<{ entries: AuditEntry[] }>('/api/audit', { limit: PAGE, before: before ?? undefined });
      setItems((prev) => (before ? [...prev, ...r.entries] : r.entries));
      setHasMore(r.entries.length === PAGE);
      setError(null);
    } catch (x) {
      setError(errorMessage(x));
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const last = items[items.length - 1]?.id;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || more || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void load(last), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, more, last, load]);

  return (
    <SubPage title="Audit log" lede="A permanent record of sign-ins, changes, reviews, corrections, deletions and exports.">
      <Card>
        {loading ? <SkeletonRows rows={8} avatar={false} /> : error && !items.length ? <ErrorState message={error} onRetry={() => void load()} /> : !items.length ? <EmptyState icon={History} title="No entries yet" /> : (
          <div className="list">
            {items.map((e) => (
              <div className="list-item" key={String(e.id)} style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="small"><strong>{e.actor_name}</strong> <span className="muted">· {actionLabel(e.action)}</span></div>
                  {detailText(e.details) && <div className="subtle xs" style={{ overflowWrap: 'anywhere' }}>{detailText(e.details)}</div>}
                </div>
                <span className="subtle xs nowrap num">{fmt.dateTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        {hasMore && !loading && <div className="load-more" ref={sentinel}><Button loading={more} onClick={() => void load(last)}>Load more</Button></div>}
      </Card>
    </SubPage>
  );
}
