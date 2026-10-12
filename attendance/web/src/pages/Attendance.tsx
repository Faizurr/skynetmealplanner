import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, CalendarPlus, Clock, Download, PencilLine, UserCheck, LogOut } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { useBranches, useEmployees } from '../lib/data';
import type { Session } from '../lib/types';
import { sessionStatusInfo } from '../lib/status';
import { fmtDuration, fmtHours } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, PageHead, Person, Pill, Select, SkeletonRows, StatusPill, Notice, Skeleton } from '../components/ui';
import { ResponsiveTable, type Column } from '../components/ResponsiveTable';
import { DateRangePicker, rangeForPreset, type Range } from '../components/DateRange';
import { CorrectionDialog, type CorrectionMode } from '../components/CorrectionDialog';
import { ManualAttendanceDialog } from '../components/ManualAttendanceDialog';
import { EventSheet } from '../components/EventSheet';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

export function TimeCell({ effective, original, corrected }: { effective: string | null; original: string | null; corrected: boolean }) {
  const fmt = useFmt();
  const changed = corrected && original && effective && new Date(original).getTime() !== new Date(effective).getTime();
  return (
    <span className="time-cell">
      <span>{effective ? fmt.time(effective) : <span className="subtle">—</span>}{changed ? <span className="sr-only"> (corrected)</span> : null}</span>
      {changed && <span className="orig" title="Original recorded time">{fmt.time(original)}</span>}
    </span>
  );
}

export function SessionDetail({ session, onClose, onCorrect }: { session: Session | null; onClose: () => void; onCorrect: (m: CorrectionMode) => void }) {
  const fmt = useFmt();
  const { can } = useAuth();
  const [manual, setManual] = useState(false);
  const s = session;
  return (
    <>
      <Dialog
        open={!!s && !manual}
        onClose={onClose}
        side
        title={s ? s.full_name : ''}
        description={s ? `${fmt.dayShort(s.effective_check_in)} · ${s.shift_name ?? 'No scheduled shift'}` : undefined}
        footer={
          s && s.status !== 'voided' ? (
            <>
              {can('corrections.request') && <Button variant="danger-ghost" icon={Ban} onClick={() => onCorrect({ kind: 'void_session', session: s })}>Void</Button>}
              {s.status === 'open' && can('attendance.manual') && <Button icon={LogOut} onClick={() => setManual(true)}>Check out now</Button>}
              {can('corrections.request') && <Button variant="primary" icon={PencilLine} onClick={() => onCorrect({ kind: 'adjust_times', session: s })}>Adjust times</Button>}
            </>
          ) : undefined
        }
      >
        {s && (
          <div className="stack">
            <div className="row-wrap">
              <StatusPill info={sessionStatusInfo(s)} />
              {s.is_late && <Pill tone="warning">Late {s.late_minutes}m</Pill>}
              {s.is_corrected && <Pill tone="accent">Corrected</Pill>}
            </div>
            <dl className="kv">
              <dt>Check-in</dt>
              <dd className="num">{fmt.dateTime(s.effective_check_in)}{s.corrected_check_in_at && <div className="subtle xs">Originally {fmt.dateTime(s.check_in_at)}</div>}</dd>
              <dt>Check-out</dt>
              <dd className="num">{s.effective_check_out ? fmt.dateTime(s.effective_check_out) : '—'}{s.corrected_check_out_at && <div className="subtle xs">Originally {s.check_out_at ? fmt.dateTime(s.check_out_at) : 'none'}</div>}</dd>
              <dt>Scheduled</dt>
              <dd className="num">{s.scheduled_start ? `${fmt.time(s.scheduled_start)} – ${fmt.time(s.scheduled_end)}` : 'Unscheduled'}</dd>
              <dt>Unpaid break</dt><dd className="num">{fmtDuration(s.break_minutes)}</dd>
              <dt>Worked</dt><dd className="num strong">{fmtDuration(s.worked_minutes)}</dd>
              <dt>Overtime</dt><dd className="num">{fmtDuration(s.overtime_minutes)}</dd>
              <dt>Branch</dt><dd>{s.branch_name ?? '—'}</dd>
              <dt>Staff ID</dt><dd>{s.staff_id}</dd>
            </dl>
            {s.needs_review && <Notice tone="attention">This session has an event awaiting review. Check the live feed to approve or reject it.</Notice>}
            <div className="row-wrap small">
              <Link to={`/staff/${s.employee_id}`} onClick={onClose}>Employee profile →</Link>
              <Link to={`/live?employee=${s.employee_id}`} onClick={onClose}>Events →</Link>
            </div>
          </div>
        )}
      </Dialog>
      {s && <ManualAttendanceDialog open={manual} onClose={() => { setManual(false); onClose(); }} employeeId={s.employee_id} defaultAction="check_out" />}
    </>
  );
}

export function AttendancePage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const today = fmt.today();
  const [range, setRange] = useState<Range>(() => rangeForPreset('7d', today));
  const employeeId = params.get('employee') ?? '';
  const branchId = params.get('branch') ?? '';
  const sessionParam = params.get('session');
  const eventParam = params.get('event');
  const [correction, setCorrection] = useState<CorrectionMode | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const branches = useBranches();
  const emps = useEmployees('all');

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const q = useQuery(
    (s) => api.get<{ sessions: Session[] }>('/api/sessions', { from: range.from, to: range.to, employee_id: employeeId || undefined, branch_id: branchId || undefined }, s).then((r) => r.sessions),
    [range.from, range.to, employeeId, branchId],
    { tables: ['attendance_sessions', 'attendance_events'] },
  );
  // Deep link: /attendance?session=<id> (may be outside the visible range).
  const deep = useQuery(
    (s) => api.get<{ sessions: Session[] }>('/api/sessions', { from: today, to: today, id: sessionParam ?? undefined }, s).then((r) => r.sessions[0] ?? null),
    [sessionParam],
    { enabled: !!sessionParam, tables: ['attendance_sessions'] },
  );
  const openSession = sessionParam ? (q.data?.find((x) => x.id === sessionParam) ?? deep.data ?? null) : null;

  const totals = useMemo(() => {
    const rows = (q.data ?? []).filter((s) => s.status !== 'voided');
    return {
      worked: rows.reduce((a, s) => a + (s.worked_minutes ?? 0), 0),
      ot: rows.reduce((a, s) => a + (s.overtime_minutes ?? 0), 0),
      late: rows.filter((s) => s.is_late).length,
      missing: rows.filter((s) => s.status === 'missing_checkout').length,
    };
  }, [q.data]);

  const columns: Column<Session>[] = [
    { key: 'emp', header: 'Employee', cell: (s) => <Person name={s.full_name} sub={s.staff_id} employeeId={s.employee_id} size="sm" /> },
    { key: 'date', header: 'Date', cell: (s) => <span className="nowrap">{fmt.dayShort(s.effective_check_in)}</span> },
    { key: 'in', header: 'In', cell: (s) => <TimeCell effective={s.effective_check_in} original={s.check_in_at} corrected={!!s.corrected_check_in_at} /> },
    { key: 'out', header: 'Out', cell: (s) => <TimeCell effective={s.effective_check_out} original={s.check_out_at} corrected={!!s.corrected_check_out_at} /> },
    { key: 'shift', header: 'Shift', cell: (s) => (s.shift_name ? <span className="time-cell"><span>{s.shift_name}</span><span className="subtle xs">{fmt.time(s.scheduled_start)} – {fmt.time(s.scheduled_end)}</span></span> : <span className="subtle">Unscheduled</span>) },
    { key: 'late', header: 'Late', className: 'num', cell: (s) => (s.is_late ? <span style={{ color: 'var(--warning-fg)', fontWeight: 600 }}>{s.late_minutes}m</span> : <span className="subtle">—</span>) },
    { key: 'break', header: 'Break', className: 'num', cell: (s) => (s.break_minutes ? fmtDuration(s.break_minutes) : <span className="subtle">—</span>) },
    { key: 'worked', header: 'Worked', className: 'num', cell: (s) => <span className="strong">{fmtDuration(s.worked_minutes)}</span> },
    { key: 'ot', header: 'OT', className: 'num', cell: (s) => (s.overtime_minutes ? fmtDuration(s.overtime_minutes) : <span className="subtle">—</span>) },
    { key: 'status', header: 'Status', cell: (s) => <span className="row-wrap"><StatusPill info={sessionStatusInfo(s)} />{s.is_corrected && <Pill tone="accent" dot={false}>Corrected</Pill>}</span> },
  ];

  return (
    <>
      <PageHead
        title="Timesheets"
        lede="Check-in and check-out pairs with hours. Corrected times show the original underneath."
        actions={
          <>
            {can('reports.export') && (
              <Button icon={Download} onClick={() => downloadFile('/api/reports/timesheet.csv', { from: range.from, to: range.to, employee_id: employeeId || undefined, branch_id: branchId || undefined }, 'timesheet.csv').then((n) => toast.success(`Downloaded ${n}`)).catch(toast.error)}>
                CSV
              </Button>
            )}
            {can('corrections.request') && <Button icon={CalendarPlus} onClick={() => setCorrection({ kind: 'add_session', employeeId: employeeId || undefined })}>Add missing session</Button>}
            {can('attendance.manual') && <Button variant="primary" icon={UserCheck} onClick={() => setManualOpen(true)}>Manual check-in/out</Button>}
          </>
        }
      />
      <div className="filters">
        <DateRangePicker value={range} onChange={setRange} today={today} presets={['7d', '30d', 'month', 'custom']} />
        <label className="sr-only" htmlFor="ts-emp">Employee</label>
        <Select id="ts-emp" value={employeeId} onChange={(e) => setParam('employee', e.target.value)}>
          <option value="">All staff</option>
          {emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </Select>
        {(branches.data?.length ?? 0) > 1 && (
          <>
            <label className="sr-only" htmlFor="ts-branch">Branch</label>
            <Select id="ts-branch" value={branchId} onChange={(e) => setParam('branch', e.target.value)}>
              <option value="">All branches</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </>
        )}
      </div>

      <div className="stack">
        <Card pad>
          {q.data ? (
            <div className="stat-inline">
              <div><div className="v">{fmtHours(totals.worked)}</div><div className="l">Worked (provisional)</div></div>
              <div><div className="v">{fmtHours(totals.ot)}</div><div className="l">Overtime</div></div>
              <div><div className="v">{q.data.length}</div><div className="l">Sessions</div></div>
              <div><div className="v">{totals.late}</div><div className="l">Late arrivals</div></div>
              <div><div className="v">{totals.missing}</div><div className="l">Missing check-outs</div></div>
            </div>
          ) : (
            <Skeleton h={40} />
          )}
        </Card>
        <Card>
          {q.loading && !q.data ? (
            <SkeletonRows rows={6} />
          ) : q.error ? (
            <ErrorState message={q.error} onRetry={q.reload} />
          ) : !q.data?.length ? (
            <EmptyState icon={Clock} title="No sessions in this range">Sessions appear when staff check in. You can also add a missing session.</EmptyState>
          ) : (
            <ResponsiveTable
              caption="Attendance sessions"
              rows={q.data}
              columns={columns}
              rowKey={(s) => s.id}
              onRowClick={(s) => setParam('session', s.id)}
              card={(s) => (
                <>
                  <div className="mcard-row">
                    <Person name={s.full_name} sub={`${fmt.dayShort(s.effective_check_in)} · ${s.shift_name ?? 'Unscheduled'}`} employeeId={s.employee_id} size="sm" />
                    <span className="strong num nowrap">{fmtDuration(s.worked_minutes)}</span>
                  </div>
                  <div className="mcard-row">
                    <span className="row num small">
                      <TimeCell effective={s.effective_check_in} original={s.check_in_at} corrected={!!s.corrected_check_in_at} />
                      <span className="subtle">→</span>
                      <TimeCell effective={s.effective_check_out} original={s.check_out_at} corrected={!!s.corrected_check_out_at} />
                    </span>
                    <span className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                      {s.is_late && <Pill tone="warning">Late {s.late_minutes}m</Pill>}
                      {s.is_corrected && <Pill tone="accent" dot={false}>Corrected</Pill>}
                      <StatusPill info={sessionStatusInfo(s)} />
                    </span>
                  </div>
                </>
              )}
            />
          )}
        </Card>
        <p className="subtle xs">Hours are provisional until reviewed. Break deductions and overtime follow each shift’s rules.</p>
      </div>

      <SessionDetail session={correction ? null : openSession} onClose={() => setParam('session', '')} onCorrect={(m) => setCorrection(m)} />
      <CorrectionDialog mode={correction} onClose={() => setCorrection(null)} onDone={() => { q.reload(); deep.reload(); }} />
      <ManualAttendanceDialog open={manualOpen} onClose={() => setManualOpen(false)} />
      <EventSheet eventId={eventParam} onClose={() => setParam('event', '')} />
    </>
  );
}
