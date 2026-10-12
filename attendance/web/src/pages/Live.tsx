import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Building2, Clock, Search, Tablet } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useFmt } from '../lib/auth';
import { useRealtimeRefresh } from '../lib/realtime';
import { useBranches, useEmployees } from '../lib/data';
import type { AttendanceEvent } from '../lib/types';
import { flagLabel } from '../lib/status';
import { Button, Card, Direction, EmptyState, ErrorState, Input, PageHead, Avatar, Select, SegmentedControl, SkeletonRows, Pill } from '../components/ui';
import { EventSheet, VerificationPill } from '../components/EventSheet';

const PAGE = 50;
type StatusFilter = '' | 'verified' | 'pending_review' | 'rejected';

export function FeedRow({ e, onOpen, isNew, showDate }: { e: AttendanceEvent; onOpen: () => void; isNew?: boolean; showDate?: boolean }) {
  const fmt = useFmt();
  const flags = e.exception_flags.filter((f) => f !== 'late' && f !== 'manual_entry' && f !== 'correction');
  return (
    <button type="button" className={`feed-item ${isNew ? 'is-new' : ''}`} onClick={onOpen} aria-label={`${e.full_name}, ${e.event_type === 'check_in' ? 'check in' : 'check out'} at ${fmt.time(e.event_time)}`}>
      <Avatar name={e.full_name} employeeId={e.employee_id} hasPhoto={e.has_photo} />
      <span className="feed-main">
        <span className="feed-line">
          <span className="strong truncate">{e.full_name}</span>
          <span className="subtle xs nowrap">{e.staff_id}</span>
        </span>
        <span className="feed-line">
          <Direction type={e.event_type} />
          <VerificationPill e={e} />
          {e.event_type === 'check_in' && e.is_late && <Pill tone="warning">Late {e.late_minutes}m</Pill>}
          {flags.slice(0, 2).map((f) => <span key={f} className="flag">{flagLabel(f)}</span>)}
        </span>
        <span className="feed-meta">
          {e.scheduled_start && e.event_type === 'check_in' && <span><Clock aria-hidden />Due {fmt.time(e.scheduled_start)}</span>}
          {e.branch_name && <span><Building2 aria-hidden />{e.branch_name}</span>}
          <span><Tablet aria-hidden />{e.device_name ?? (e.source === 'manual' ? 'Dashboard' : 'Unknown kiosk')}</span>
        </span>
      </span>
      <span className="feed-time">
        <span className="t" style={{ display: 'block' }}>{fmt.time(e.event_time)}</span>
        {showDate && <span className="d" style={{ display: 'block' }}>{fmt.dayShort(e.event_time)}</span>}
      </span>
    </button>
  );
}

export function LivePage() {
  const fmt = useFmt();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as StatusFilter;
  const employeeId = params.get('employee') ?? '';
  const branchId = params.get('branch') ?? '';
  const openId = params.get('event');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AttendanceEvent[]>([]);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branches = useBranches();
  const emps = useEmployees('all');
  const sentinel = useRef<HTMLDivElement>(null);
  const filters = useMemo(() => ({ status: status || undefined, employee_id: employeeId || undefined, branch_id: branchId || undefined }), [status, employeeId, branchId]);
  const reqSeq = useRef(0);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const loadFirst = useCallback(
    async (merge: boolean) => {
      const seq = ++reqSeq.current;
      if (!merge) setLoading(true);
      try {
        const r = await api.get<{ events: AttendanceEvent[] }>('/api/events', { ...filters, limit: PAGE });
        if (seq !== reqSeq.current) return;
        setError(null);
        if (!merge) {
          setItems(r.events);
          setHasMore(r.events.length === PAGE);
          setNewIds(new Set());
        } else {
          setItems((prev) => {
            const known = new Set(prev.map((x) => x.id));
            const fresh = r.events.filter((x) => !known.has(x.id));
            const updated = new Map(r.events.map((x) => [x.id, x]));
            if (fresh.length) setNewIds(new Set(fresh.map((x) => x.id)));
            const merged = [...fresh, ...prev.map((x) => updated.get(x.id) ?? x)];
            return merged.sort((a, b) => (a.event_time < b.event_time ? 1 : a.event_time > b.event_time ? -1 : 0));
          });
        }
      } catch (e) {
        if (seq === reqSeq.current && !merge) setError(errorMessage(e));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    void loadFirst(false);
  }, [loadFirst]);

  useRealtimeRefresh(['attendance_events', 'attendance_sessions'], () => void loadFirst(true));

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !items.length) return;
    setLoadingMore(true);
    try {
      const last = items[items.length - 1];
      const r = await api.get<{ events: AttendanceEvent[] }>('/api/events', { ...filters, limit: PAGE, before: last.event_time, before_id: last.id });
      setItems((prev) => {
        const known = new Set(prev.map((x) => x.id));
        return [...prev, ...r.events.filter((x) => !known.has(x.id))];
      });
      setHasMore(r.events.length === PAGE);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [filters, hasMore, items, loadingMore]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore]);

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? items.filter((e) => e.full_name.toLowerCase().includes(s) || e.staff_id.toLowerCase().includes(s)) : items;
  }, [items, search]);

  let lastDay = '';
  return (
    <>
      <PageHead title="Live feed" lede="Every check-in and check-out as it happens. Tap an event for details." />
      <div className="filters">
        <div className="input-icon">
          <Search aria-hidden />
          <label className="sr-only" htmlFor="live-search">Search loaded events by name or staff ID</label>
          <Input id="live-search" type="search" placeholder="Search name or staff ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="sr-only" htmlFor="live-emp">Employee</label>
        <Select id="live-emp" value={employeeId} onChange={(e) => setParam('employee', e.target.value)}>
          <option value="">All staff</option>
          {emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </Select>
        {(branches.data?.length ?? 0) > 1 && (
          <>
            <label className="sr-only" htmlFor="live-branch">Branch</label>
            <Select id="live-branch" value={branchId} onChange={(e) => setParam('branch', e.target.value)}>
              <option value="">All branches</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </>
        )}
        <SegmentedControl<StatusFilter>
          label="Verification status"
          value={status}
          onChange={(v) => setParam('status', v)}
          options={[{ value: '', label: 'All' }, { value: 'verified', label: 'Verified' }, { value: 'pending_review', label: 'Awaiting review' }, { value: 'rejected', label: 'Rejected' }]}
        />
      </div>
      <Card>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : error && !items.length ? (
          <ErrorState message={error} onRetry={() => void loadFirst(false)} />
        ) : shown.length === 0 ? (
          <EmptyState icon={Activity} title={items.length ? 'No matching events' : status === 'pending_review' ? 'Nothing awaiting review' : 'No attendance yet'}>
            {items.length ? 'Try a different name or clear the search.' : status || employeeId || branchId ? 'Try removing a filter.' : 'Events appear here instantly when staff check in at the kiosk.'}
          </EmptyState>
        ) : (
          <div role="feed" aria-busy={loadingMore} aria-label="Attendance events">
            {shown.map((e) => {
              const day = fmt.ymdOf(e.event_time);
              const sep = day !== lastDay;
              lastDay = day;
              return (
                <Fragment key={e.id}>
                  {sep && <div className="day-sep">{day === fmt.today() ? 'Today' : fmt.dayShort(e.event_time)}</div>}
                  <FeedRow e={e} isNew={newIds.has(e.id)} onOpen={() => setParam('event', e.id)} />
                </Fragment>
              );
            })}
          </div>
        )}
        {hasMore && !loading && (
          <div className="load-more" ref={sentinel}>
            <Button loading={loadingMore} onClick={() => void loadMore()}>Load older events</Button>
          </div>
        )}
      </Card>
      <EventSheet eventId={openId} onClose={() => setParam('event', '')} />
    </>
  );
}
