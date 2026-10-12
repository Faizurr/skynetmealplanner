import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, Bell, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, ScanFace, Tablet, UserPlus, Users, UserCheck, WifiOff, type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery, useNow } from '../lib/useQuery';
import { useBranches } from '../lib/data';
import type { Overview, RosterRow, RosterStatus } from '../lib/types';
import { ROSTER_INFO, ROSTER_ORDER, type Tone } from '../lib/status';
import { addDaysYmd, fmtDuration, fmtRelative, fmtYmd } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, IconButton, Input, PageHead, Person, Select, Skeleton, SkeletonRows, StatusPill } from '../components/ui';
import { ManualAttendanceDialog } from '../components/ManualAttendanceDialog';

interface Kpi {
  label: string;
  value: number;
  tone: Tone;
  to?: string;
  sub?: string;
}

function KpiCard({ k }: { k: Kpi }) {
  const body = (
    <>
      <span className="kpi-label"><span className={`dot tone-${k.tone}`} aria-hidden />{k.label}</span>
      <span className="kpi-value">{k.value}</span>
      {k.sub && <span className="kpi-sub">{k.sub}</span>}
    </>
  );
  const cls = `kpi tone-${k.tone} ${k.value === 0 ? 'is-zero' : ''}`;
  return k.to ? <Link to={k.to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

function rosterTimes(r: RosterRow, fmt: ReturnType<typeof useFmt>) {
  switch (r.status) {
    case 'working':
    case 'unscheduled_working':
      return { big: `In ${fmt.time(r.check_in_at)}`, small: r.is_late ? `Late ${r.late_minutes}m` : r.scheduled_start ? `Due ${fmt.time(r.scheduled_start)}` : 'No shift today' };
    case 'checked_out':
      return { big: fmtDuration(r.worked_minutes), small: `${fmt.time(r.check_in_at)} – ${fmt.time(r.check_out_at)}` };
    case 'late_not_arrived':
      return { big: `Due ${fmt.time(r.scheduled_start)}`, small: r.shift_name ?? '' };
    case 'not_yet_due':
      return { big: fmt.time(r.scheduled_start), small: r.shift_name ?? '' };
    case 'absent':
      return { big: 'No check-in', small: r.scheduled_start ? `Due ${fmt.time(r.scheduled_start)}` : '' };
    default:
      return { big: '', small: '' };
  }
}

export function TodayPage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const today = fmt.today();
  const date = params.get('date') ?? today;
  const branchId = params.get('branch') ?? '';
  const [manualOpen, setManualOpen] = useState(false);
  const branches = useBranches();
  const q = useQuery(
    (s) => api.get<Overview>('/api/overview', { date, branch_id: branchId || undefined }, s),
    [date, branchId],
    { tables: ['attendance_events', 'attendance_sessions', 'attendance_exceptions', 'devices', 'employees', 'face_enrollments'] },
  );
  const o = q.data;
  const isToday = date === today;

  const setDate = (d: string) => {
    const p = new URLSearchParams(params);
    if (d === today) p.delete('date');
    else p.set('date', d);
    setParams(p, { replace: true });
  };

  const groups = useMemo(() => {
    const g = new Map<RosterStatus, RosterRow[]>();
    for (const r of o?.roster ?? []) g.set(r.status, [...(g.get(r.status) ?? []), r]);
    return ROSTER_ORDER.filter((s) => g.has(s)).map((s) => ({ status: s, rows: g.get(s)! }));
  }, [o]);

  const m = o?.metrics;
  const kpis: Kpi[] = m
    ? [
        { label: 'Expected', value: m.expected_today, tone: 'neutral', sub: 'scheduled shifts' },
        { label: 'Working now', value: m.currently_working, tone: 'success' },
        { label: 'Checked out', value: m.checked_out, tone: 'neutral' },
        { label: 'Not yet arrived', value: m.not_yet_arrived, tone: 'neutral', sub: m.late_not_arrived ? `${m.late_not_arrived} overdue` : undefined },
        { label: 'Late arrivals', value: m.late_arrivals, tone: 'warning' },
        { label: 'Absent', value: m.absent, tone: 'error' },
        { label: 'Missing check-outs', value: m.missing_checkouts, tone: 'warning', to: '/attendance' },
        { label: 'Needs review', value: m.pending_review, tone: 'attention', to: '/live?status=pending_review' },
      ]
    : [];

  type Att = { icon: LucideIcon; tone: Tone; label: string; detail: string; count: number; to: string; show: boolean };
  const attention: Att[] = m
    ? ([
        { icon: AlertTriangle, tone: 'attention', label: 'Events awaiting review', detail: 'Not counted as verified until approved', count: m.pending_review, to: '/live?status=pending_review', show: true },
        { icon: ScanFace, tone: 'attention', label: 'Face enrollments to confirm', detail: 'Confirm identity before they can be used', count: m.pending_enrollments, to: '/enrollments', show: can('biometrics.manage') },
        { icon: ClipboardCheck, tone: 'attention', label: 'Corrections to approve', detail: 'Requested time changes', count: m.pending_corrections, to: '/corrections', show: true },
        { icon: Bell, tone: 'warning', label: 'Open alerts', detail: Object.entries(o!.exceptions_by_kind).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(' · ') || 'Late arrivals, missing check-outs, kiosk issues', count: m.open_exceptions, to: '/alerts', show: true },
        { icon: WifiOff, tone: 'error', label: 'Kiosks offline', detail: 'Check power and Wi-Fi', count: m.devices_offline, to: '/devices', show: true },
        { icon: Tablet, tone: 'neutral', label: 'Kiosks with unsynced events', detail: 'Events waiting to upload', count: m.devices_with_unsynced_events, to: '/devices', show: true },
      ] as Att[]).filter((a) => a.show && a.count > 0)
    : [];

  const multiBranch = (branches.data?.filter((b) => b.active).length ?? 0) > 1;

  return (
    <>
      <PageHead
        title={isToday ? 'Today' : fmtYmd(date, { weekday: true })}
        lede={`${isToday ? fmtYmd(date, { weekday: true }) : 'Viewing another day'} · times in ${fmt.tz.split('/').pop()?.replace(/_/g, ' ')}`}
        actions={
          <>
            <div className="row" role="group" aria-label="Choose day">
              <IconButton icon={ChevronLeft} label="Previous day" variant="secondary" onClick={() => setDate(addDaysYmd(date, -1))} />
              <label className="sr-only" htmlFor="today-date">Date</label>
              <Input id="today-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto', flex: '1 1 150px' }} />
              <IconButton icon={ChevronRight} label="Next day" variant="secondary" onClick={() => setDate(addDaysYmd(date, 1))} />
              {!isToday && <Button onClick={() => setDate(today)}>Today</Button>}
            </div>
            {multiBranch && (
              <>
                <label className="sr-only" htmlFor="today-branch">Branch</label>
                <Select id="today-branch" value={branchId} style={{ width: 'auto', flex: '1 1 160px' }} onChange={(e) => { const p = new URLSearchParams(params); if (e.target.value) p.set('branch', e.target.value); else p.delete('branch'); setParams(p, { replace: true }); }}>
                  <option value="">All branches</option>
                  {branches.data?.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </>
            )}
            {can('attendance.manual') && <Button variant="primary" icon={UserCheck} onClick={() => setManualOpen(true)}>Manual check-in</Button>}
          </>
        }
      />

      {q.error && !o ? (
        <Card><ErrorState message={q.error} onRetry={q.reload} /></Card>
      ) : (
        <div className="stack-lg">
          <div className="kpis" aria-label="Key figures" aria-busy={q.loading}>
            {o
              ? kpis.map((k) => <KpiCard key={k.label} k={k} />)
              : Array.from({ length: 8 }).map((_, i) => (
                  <div className="kpi" key={i}><Skeleton w={80} h={10} /><Skeleton w={44} h={30} /></div>
                ))}
          </div>

          <div className="grid grid-sidebar">
            <Card title="Roster" hint={o ? `${o.roster.length} staff · who is working first` : undefined} id="roster">
              {!o ? (
                <SkeletonRows rows={6} />
              ) : o.roster.length === 0 ? (
                <EmptyState icon={Users} title="No staff yet" action={can('employees.write') ? <Link className="btn btn-primary" to="/staff?new=1"><UserPlus aria-hidden width={16} height={16} />Add employee</Link> : undefined}>
                  Add your team and assign shifts. Their status for the day will appear here.
                </EmptyState>
              ) : (
                groups.map((g) => (
                  <div key={g.status}>
                    <div className="section-title">
                      <span className={`dot tone-${ROSTER_INFO[g.status].tone}`} style={{ width: 7, height: 7, borderRadius: 4 }} aria-hidden />
                      {ROSTER_INFO[g.status].label} <span className="count">{g.rows.length}</span>
                    </div>
                    {g.rows.map((r) => {
                      const t = rosterTimes(r, fmt);
                      return (
                        <Link key={r.employee.id} to={`/staff/${r.employee.id}`} className="roster-item">
                          <Person name={r.employee.full_name} sub={[r.employee.job_title, r.shift_name].filter(Boolean).join(' · ') || `Staff ID ${r.employee.staff_id}`} employeeId={r.employee.id} />
                          <div className="roster-times">
                            <div className="big">{t.big}</div>
                            <div className={r.is_late ? 'nowrap' : ''} style={r.is_late ? { color: 'var(--warning-fg)', fontWeight: 600 } : undefined}>{t.small}</div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ))
              )}
            </Card>

            <div className="stack today-side">
              <Card title="Needs your attention">
                {!o ? (
                  <SkeletonRows rows={3} avatar={false} />
                ) : attention.length === 0 ? (
                  <div className="all-clear">
                    <span className="attention-icon tone-success"><CheckCircle2 aria-hidden /></span>
                    <span>All clear. Nothing needs your review right now.</span>
                  </div>
                ) : (
                  <div className="list">
                    {attention.map((a) => (
                      <Link key={a.label} to={a.to} className="attention-item">
                        <span className={`attention-icon tone-${a.tone}`}><a.icon aria-hidden /></span>
                        <span className="grow">
                          <span className="strong small" style={{ display: 'block' }}>{a.label}</span>
                          <span className="subtle xs truncate" style={{ display: 'block' }}>{a.detail}</span>
                        </span>
                        <span className="attention-count">{a.count}</span>
                        <ChevronRight className="chev" aria-hidden width={16} height={16} />
                      </Link>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Kiosks" actions={<Link to="/devices" className="small">Manage</Link>}>
                <div className="card-body">
                  {!o ? (
                    <Skeleton h={52} r={12} />
                  ) : o.devices.length === 0 ? (
                    <div className="row-between">
                      <span className="muted small">No active kiosk yet.</span>
                      {can('devices.manage') && <Link to="/devices?add=1" className="btn btn-sm">Add kiosk</Link>}
                    </div>
                  ) : (
                    <div className="device-strip">
                      {o.devices.map((d) => (
                        <Link key={d.id} to="/devices" className="device-chip">
                          <Tablet aria-hidden />
                          <span>
                            <span className="n" style={{ display: 'block' }}>{d.name}</span>
                            <span className="s" style={{ display: 'block' }}>
                              {d.status === 'pending' ? 'Waiting to pair' : d.online ? `Online · ${fmtRelative(d.last_seen_at, now)}` : `Offline · ${fmtRelative(d.last_seen_at, now)}`}
                              {d.pending_queue_count > 0 ? ` · ${d.pending_queue_count} unsynced` : ''}
                            </span>
                          </span>
                          <StatusPill info={d.status === 'pending' ? { label: 'Pending', tone: 'neutral' } : d.online ? { label: 'Online', tone: 'success' } : { label: 'Offline', tone: 'error' }} />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

            </div>
          </div>
        </div>
      )}
      <ManualAttendanceDialog open={manualOpen} onClose={() => setManualOpen(false)} />
    </>
  );
}
