import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BarChart3, Download, FileText, Lightbulb, Printer } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { useBranches } from '../lib/data';
import type { Analytics } from '../lib/types';
import { daysBetween, fmtDuration, fmtHours, fmtPct, fmtYmd } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, InfoTip, Notice, PageHead, Select, Skeleton, Person } from '../components/ui';
import { ResponsiveTable, type Column } from '../components/ResponsiveTable';
import { DateRangePicker, rangeForPreset, type Range } from '../components/DateRange';
import { Legend, Meter, StackedBars } from '../components/Charts';
import { useToast } from '../components/Toast';

/** Definitions mirror the comment at the top of server/src/analytics.ts. */
const DEF = {
  attendance: 'Attended ÷ scheduled shifts that have ended. A scheduled shift is attended when a non-voided session is linked to it.',
  punctuality: 'On-time attended shifts ÷ attended shifts. Late means checking in after the scheduled start plus the shift’s grace minutes. Unscheduled sessions are not counted.',
  late: 'Number of attended scheduled shifts where check-in was late (after start + grace). The percentage is late ÷ attended.',
  avgLate: 'Average minutes late, counting only late arrivals.',
  absences: 'Scheduled shifts that have ended with no session linked to them.',
  missing: 'Sessions closed as “missing check-out”, or still open past their scheduled end.',
  worked: 'Total from closed sessions, after unpaid breaks. Uses corrected times when a correction was approved. Provisional until reviewed.',
  overtime: 'Minutes beyond each shift’s overtime threshold (or the restaurant default for unscheduled work).',
  avgWorked: 'Average worked time per closed session.',
  consistency: 'Attended ÷ (attended + absences) for the employee.',
};

type EmpRow = Analytics['employees'][number];
type SortKey = 'full_name' | 'attended' | 'late' | 'absences' | 'worked_minutes' | 'overtime_minutes' | 'punctuality_rate' | 'consistency' | 'missing_checkouts';

function Stat({ label, value, sub, tip, tone }: { label: string; value: string; sub?: string; tip: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ? `tone-${tone}` : ''}`}>
      <span className="kpi-label">{label}<InfoTip label={`How “${label}” is calculated`}>{tip}</InfoTip></span>
      <span className="kpi-value" style={{ fontSize: 'var(--text-2xl)' }}>{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

export function InsightsPage() {
  const fmt = useFmt();
  const { can, me } = useAuth();
  const toast = useToast();
  const today = fmt.today();
  const [range, setRange] = useState<Range>(() => rangeForPreset('30d', today));
  const [branchId, setBranchId] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'worked_minutes', dir: 'desc' });
  const branches = useBranches();
  const q = useQuery((s) => api.get<Analytics>('/api/analytics', { from: range.from, to: range.to, branch_id: branchId || undefined }, s), [range.from, range.to, branchId], { tables: ['attendance_sessions'] });
  const a = q.data;
  const days = daysBetween(range.from, range.to) + 1;

  const employees = useMemo(() => {
    const rows = [...(a?.employees ?? [])];
    rows.sort((x, y) => {
      const k = sort.key;
      const av = x[k];
      const bv = y[k];
      const cmp = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : ((av as number | null) ?? -1) - ((bv as number | null) ?? -1);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [a, sort]);

  const hourData = useMemo(() => {
    const rows = a?.arrival_by_hour ?? [];
    const withData = rows.filter((r) => r.check_ins > 0).map((r) => r.hour);
    let lo = withData.length ? Math.max(0, Math.min(...withData) - 1) : 6;
    let hi = withData.length ? Math.min(23, Math.max(...withData) + 1) : 22;
    while (hi - lo < 8) {
      if (lo > 0) lo--;
      if (hi - lo < 8 && hi < 23) hi++;
      if (lo === 0 && hi === 23) break;
    }
    return rows.filter((r) => r.hour >= lo && r.hour <= hi).map((r) => {
      const h12 = r.hour % 12 === 0 ? 12 : r.hour % 12;
      const label = `${h12}${r.hour < 12 ? 'a' : 'p'}`;
      return { key: String(r.hour), label, base: r.check_ins - r.late, top: r.late, tip: <><strong>{h12}:00 {r.hour < 12 ? 'am' : 'pm'}</strong> · {r.check_ins} check-ins, {r.late} late</> };
    });
  }, [a]);

  const dailyData = useMemo(
    () =>
      (a?.daily ?? []).map((d) => ({
        key: d.date,
        label: fmtYmd(d.date, { year: false }),
        base: Math.max(0, d.sessions - d.late),
        top: d.late,
        tip: <><strong>{fmtYmd(d.date, { weekday: true })}</strong> · {d.sessions} sessions ({d.late} late) · {d.scheduled} scheduled · {d.absences} absent · {fmtHours(d.worked_minutes)}</>,
      })),
    [a],
  );

  const onSort = (k: string) => setSort((s) => (s.key === k ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k as SortKey, dir: k === 'full_name' ? 'asc' : 'desc' }));
  const empCols: Column<EmpRow>[] = [
    { key: 'full_name', header: 'Employee', sortable: true, cell: (e) => <Person name={e.full_name} sub={e.staff_id} employeeId={e.employee_id} size="sm" /> },
    { key: 'attended', header: 'Attended', sortable: true, className: 'num', cell: (e) => `${e.attended}/${e.scheduled}` },
    { key: 'late', header: 'Late', sortable: true, className: 'num', cell: (e) => e.late || '—' },
    { key: 'absences', header: 'Absent', sortable: true, className: 'num', cell: (e) => e.absences || '—' },
    { key: 'punctuality_rate', header: 'On time', sortable: true, className: 'num', cell: (e) => <span className="row" style={{ justifyContent: 'flex-end' }}><Meter value={e.punctuality_rate} tone={e.punctuality_rate != null && e.punctuality_rate < 80 ? 'warning' : 'success'} />{fmtPct(e.punctuality_rate)}</span> },
    { key: 'consistency', header: 'Consistency', sortable: true, className: 'num', cell: (e) => fmtPct(e.consistency) },
    { key: 'worked_minutes', header: 'Worked', sortable: true, className: 'num', cell: (e) => fmtHours(e.worked_minutes) },
    { key: 'overtime_minutes', header: 'OT', sortable: true, className: 'num', cell: (e) => (e.overtime_minutes ? fmtHours(e.overtime_minutes) : '—') },
    { key: 'missing_checkouts', header: 'Missing out', sortable: true, className: 'num', cell: (e) => e.missing_checkouts || '—' },
  ];

  const dl = (path: string, name: string) =>
    downloadFile(path, { from: range.from, to: range.to, branch_id: branchId || undefined }, name).then((n) => toast.success(`Downloaded ${n}`)).catch(toast.error);
  const s = a?.summary;
  const multiBranch = (branches.data?.length ?? 0) > 1;

  return (
    <>
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h1>{me?.restaurant.name} — Attendance report</h1>
        <p>{fmtYmd(range.from)} to {fmtYmd(range.to)} · {fmt.tz} · PROVISIONAL — review corrections before payroll.</p>
      </div>
      <PageHead
        title="Insights"
        lede="Patterns in punctuality, absences and hours."
        actions={can('reports.export') && <Button icon={Printer} className="no-print" onClick={() => window.print()}>Print report</Button>}
      />
      <div className="filters no-print">
        <DateRangePicker value={range} onChange={setRange} today={today} />
        {multiBranch && (
          <>
            <label className="sr-only" htmlFor="ins-branch">Branch</label>
            <Select id="ins-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </>
        )}
      </div>

      {q.error && !a ? (
        <Card><ErrorState message={q.error} onRetry={q.reload} /></Card>
      ) : (
        <div className="stack-lg">
          <Notice tone="warning" icon={AlertTriangle}>
            Hours and payroll figures are <strong>provisional</strong> until you’ve reviewed corrections, missing check-outs and events awaiting review.
          </Notice>

          <div className="kpis" aria-busy={!a}>
            {!s
              ? Array.from({ length: 8 }).map((_, i) => <div className="kpi" key={i}><Skeleton w={90} h={10} /><Skeleton w={60} h={26} /></div>)
              : (
                <>
                  <Stat label="Attendance rate" value={fmtPct(s.attendance_rate)} sub={`${s.attended_scheduled_shifts} of ${s.scheduled_shifts} shifts`} tip={DEF.attendance} />
                  <Stat label="Punctuality" value={fmtPct(s.punctuality_rate)} sub="on-time arrivals" tip={DEF.punctuality} tone={s.punctuality_rate != null && s.punctuality_rate < 80 ? 'warning' : undefined} />
                  <Stat label="Late arrivals" value={String(s.late_arrivals)} sub={s.late_frequency != null ? `${fmtPct(s.late_frequency)} of attended` : undefined} tip={DEF.late} tone={s.late_arrivals ? 'warning' : undefined} />
                  <Stat label="Avg. lateness" value={s.average_lateness_minutes != null ? `${s.average_lateness_minutes}m` : '—'} tip={DEF.avgLate} />
                  <Stat label="Absences" value={String(s.absences)} tip={DEF.absences} tone={s.absences ? 'error' : undefined} />
                  <Stat label="Missing check-outs" value={String(s.missing_checkouts)} tip={DEF.missing} tone={s.missing_checkouts ? 'warning' : undefined} />
                  <Stat label="Hours worked" value={fmtHours(s.total_worked_minutes)} sub={`${s.total_sessions} sessions · avg ${fmtDuration(s.average_worked_minutes)}`} tip={DEF.worked} />
                  <Stat label="Overtime" value={fmtHours(s.total_overtime_minutes)} tip={DEF.overtime} />
                </>
              )}
          </div>

          <Card title="Insights" hint={`${fmtYmd(range.from)} – ${fmtYmd(range.to)} · ${days} days`}>
            {!a ? <div className="card-body"><Skeleton h={48} /></div> : a.insights.length === 0 ? (
              <EmptyState icon={Lightbulb} title="No notable patterns">Nothing stands out in this period. Insights only appear when there’s enough data to support them.</EmptyState>
            ) : (
              <div className="list">
                {a.insights.map((i) => (
                  <div className="attention-item" key={i.id}>
                    <span className={`attention-icon tone-${i.severity === 'warning' ? 'warning' : 'neutral'}`}>{i.severity === 'warning' ? <AlertTriangle aria-hidden /> : <Lightbulb aria-hidden />}</span>
                    <span className="grow">
                      <span className="strong small" style={{ display: 'block' }}>{i.title}</span>
                      <span className="muted xs" style={{ display: 'block' }}>{i.detail}</span>
                      {i.employee_ids?.length === 1 && <Link className="xs" to={`/staff/${i.employee_ids[0]}`}>View employee</Link>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-2">
            <Card title="Daily attendance" hint="Sessions per day; amber = late arrivals">
              <div className="card-body stack-sm">
                {!a ? <Skeleton h={180} /> : <><StackedBars data={dailyData} label="Sessions per day with late arrivals" /><Legend items={[{ label: 'On time / unscheduled', className: 'bar' }, { label: 'Late', className: 'bar-late' }]} /></>}
              </div>
            </Card>
            <Card title="Arrivals by hour" hint="When staff check in (local time)">
              <div className="card-body stack-sm">
                {!a ? <Skeleton h={180} /> : <><StackedBars data={hourData} label="Check-ins by hour of day" /><Legend items={[{ label: 'On time', className: 'bar' }, { label: 'Late', className: 'bar-late' }]} /></>}
              </div>
            </Card>
          </div>

          <div className="grid grid-2">
            <Card title="By weekday">
              {!a ? <div className="card-body"><Skeleton h={160} /></div> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th scope="col">Day</th><th className="num" scope="col">Sessions</th><th className="num" scope="col">Late</th><th className="num" scope="col">Late rate</th><th className="num" scope="col">Absent</th></tr></thead>
                    <tbody>
                      {a.by_weekday.map((w) => (
                        <tr key={w.weekday}><td>{w.name}</td><td className="num">{w.sessions}</td><td className="num">{w.late}</td><td className="num">{fmtPct(w.late_rate)}</td><td className="num">{w.absences}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Reports" hint="CSV files open in Excel, Numbers or Google Sheets">
              <div className="card-body stack-sm">
                {can('reports.export') ? (
                  <>
                    <Button icon={Download} onClick={() => void dl('/api/reports/timesheet.csv', 'timesheet.csv')}>Timesheet CSV (payroll, provisional)</Button>
                    <Button icon={Download} onClick={() => void dl('/api/reports/summary.csv', 'summary.csv')}>Summary per employee CSV</Button>
                    <Button icon={Download} onClick={() => void dl('/api/reports/events.csv', 'events.csv')}>All events CSV</Button>
                    <Button icon={FileText} className="no-print" onClick={() => window.print()}>Printable report</Button>
                  </>
                ) : (
                  <p className="muted small">You don’t have permission to export reports.</p>
                )}
                <p className="subtle xs">Reports cover {fmtYmd(range.from)} – {fmtYmd(range.to)}{branchId ? ' for the selected branch' : ''}.</p>
              </div>
            </Card>
          </div>

          {multiBranch && a && a.by_branch.length > 0 && (
            <Card title="Branches">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th scope="col">Branch</th><th className="num" scope="col">Sessions</th><th className="num" scope="col">Late rate</th><th className="num" scope="col">Missing out</th><th className="num" scope="col">Worked</th></tr></thead>
                  <tbody>
                    {a.by_branch.map((b) => (
                      <tr key={b.branch_id}><td>{b.name}</td><td className="num">{b.sessions}</td><td className="num">{fmtPct(b.late_rate)}</td><td className="num">{b.missing_checkouts}</td><td className="num">{fmtHours(b.worked_minutes)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title="Employees" hint={<>Tap a column to sort. <span className="nowrap">Consistency <InfoTip align="end" label="How consistency is calculated">{DEF.consistency}</InfoTip></span></>}>
            {!a ? <div className="card-body"><Skeleton h={160} /></div> : employees.length === 0 ? (
              <EmptyState icon={BarChart3} title="No employee data">Add staff and record attendance to see per-employee figures.</EmptyState>
            ) : (
              <ResponsiveTable
                caption="Per-employee attendance"
                rows={employees}
                columns={empCols}
                rowKey={(e) => e.employee_id}
                sort={sort}
                onSort={onSort}
                card={(e) => (
                  <>
                    <div className="mcard-row">
                      <Person name={e.full_name} sub={e.staff_id} employeeId={e.employee_id} size="sm" />
                      <span className="strong num">{fmtHours(e.worked_minutes)}</span>
                    </div>
                    <div className="mcard-meta">
                      <span><span className="k">Attended</span> {e.attended}/{e.scheduled}</span>
                      <span><span className="k">On time</span> {fmtPct(e.punctuality_rate)}</span>
                      <span><span className="k">Late</span> {e.late}</span>
                      <span><span className="k">Absent</span> {e.absences}</span>
                      {e.overtime_minutes > 0 && <span><span className="k">OT</span> {fmtHours(e.overtime_minutes)}</span>}
                    </div>
                  </>
                )}
              />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
