import { useEffect, useId, useState } from 'react';
import { CalendarClock, Moon, Plus } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { useBranches } from '../lib/data';
import type { Shift } from '../lib/types';
import { fmtClock, fmtDays, fmtDuration, WEEKDAYS } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, Field, InlineError, Input, PageHead, Pill, Select, SkeletonRows, TextField, Toggle, Notice } from '../components/ui';
import { ResponsiveTable, type Column } from '../components/ResponsiveTable';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

interface ShiftForm {
  name: string;
  branch_id: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  grace_minutes: string;
  unpaid_break_minutes: string;
  break_applies_after_minutes: string;
  overtime_after_minutes: string;
  active: boolean;
}

const blank: ShiftForm = { name: '', branch_id: '', start_time: '09:00', end_time: '17:00', days_of_week: [1, 2, 3, 4, 5], grace_minutes: '5', unpaid_break_minutes: '0', break_applies_after_minutes: '360', overtime_after_minutes: '', active: true };

function shiftLength(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let m = eh * 60 + em - (sh * 60 + sm);
  if (m <= 0) m += 1440;
  return m;
}

function ShiftDialog({ open, onClose, shift, onSaved }: { open: boolean; onClose: () => void; shift: Shift | null; onSaved: () => void }) {
  const toast = useToast();
  const branches = useBranches();
  const id = useId();
  const [f, setF] = useState<ShiftForm>(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setF(
      shift
        ? {
            name: shift.name, branch_id: shift.branch_id ?? '', start_time: shift.start_time, end_time: shift.end_time, days_of_week: shift.days_of_week,
            grace_minutes: String(shift.grace_minutes), unpaid_break_minutes: String(shift.unpaid_break_minutes), break_applies_after_minutes: String(shift.break_applies_after_minutes),
            overtime_after_minutes: shift.overtime_after_minutes == null ? '' : String(shift.overtime_after_minutes), active: shift.active,
          }
        : blank,
    );
  }, [open, shift]);
  const set = (k: keyof ShiftForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggleDay = (d: number) => setF((x) => ({ ...x, days_of_week: x.days_of_week.includes(d) ? x.days_of_week.filter((y) => y !== d) : [...x.days_of_week, d].sort() }));
  const overnight = !!f.start_time && !!f.end_time && f.end_time <= f.start_time;
  const int = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: f.name.trim(), branch_id: f.branch_id || null, start_time: f.start_time, end_time: f.end_time, days_of_week: f.days_of_week,
        grace_minutes: int(f.grace_minutes), unpaid_break_minutes: int(f.unpaid_break_minutes), break_applies_after_minutes: int(f.break_applies_after_minutes),
        overtime_after_minutes: f.overtime_after_minutes.trim() === '' ? null : int(f.overtime_after_minutes), active: f.active,
      };
      if (shift) await api.put(`/api/shifts/${shift.id}`, body);
      else await api.post('/api/shifts', body);
      toast.success(shift ? 'Shift updated' : 'Shift created');
      onSaved();
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const len = f.start_time && f.end_time ? shiftLength(f.start_time, f.end_time) : 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={shift ? 'Edit shift' : 'New shift'}
      description={shift ? 'Changes apply to future check-ins. Past sessions keep the times they were scheduled with.' : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.name.trim() || !f.days_of_week.length} onClick={() => void save()}>{shift ? 'Save shift' : 'Create shift'}</Button></>}
    >
      <div className="stack">
        <div className="form-grid">
          <TextField label="Name" value={f.name} onChange={set('name')} placeholder="e.g. Morning, Dinner service" data-autofocus />
          {(branches.data?.length ?? 0) > 1 && (
            <Field label="Branch" htmlFor={`${id}-b`}>
              <Select id={`${id}-b`} value={f.branch_id} onChange={set('branch_id')}>
                <option value="">All branches</option>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Days">
          <div className="chips" role="group" aria-label="Days of week">
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" className="chip" aria-pressed={f.days_of_week.includes(i + 1)} onClick={() => toggleDay(i + 1)}>{d}</button>
            ))}
          </div>
        </Field>
        <div className="form-grid">
          <Field label="Starts" htmlFor={`${id}-s`}><Input id={`${id}-s`} type="time" value={f.start_time} onChange={set('start_time')} /></Field>
          <Field label="Ends" htmlFor={`${id}-e`} help={len ? `${fmtDuration(len)} long` : undefined}><Input id={`${id}-e`} type="time" value={f.end_time} onChange={set('end_time')} /></Field>
        </div>
        {overnight && <Notice icon={Moon}>Overnight shift: ends the next day at {fmtClock(f.end_time)}.</Notice>}
        <div className="form-grid">
          <TextField label="Grace period (min)" type="number" inputMode="numeric" min={0} max={240} value={f.grace_minutes} onChange={set('grace_minutes')} help="Check-ins within this many minutes after the start are not late." />
          <TextField label="Overtime after (min)" optional type="number" inputMode="numeric" min={0} max={1440} value={f.overtime_after_minutes} onChange={set('overtime_after_minutes')} help="Worked minutes beyond this count as overtime. Empty = no overtime for this shift." />
          <TextField label="Unpaid break (min)" type="number" inputMode="numeric" min={0} max={480} value={f.unpaid_break_minutes} onChange={set('unpaid_break_minutes')} help="Deducted from worked time…" />
          <TextField label="…when worked longer than (min)" type="number" inputMode="numeric" min={0} max={1440} value={f.break_applies_after_minutes} onChange={set('break_applies_after_minutes')} help="e.g. 360 = only deduct for shifts over 6 hours." />
        </div>
        {shift && <Toggle checked={f.active} onChange={(v) => setF((x) => ({ ...x, active: v }))} label="Active" description="Inactive shifts are no longer scheduled." />}
        <InlineError>{err}</InlineError>
      </div>
    </Dialog>
  );
}

export function ShiftsPage() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<Shift | null | 'new'>(null);
  const q = useQuery((s) => api.get<{ shifts: Shift[] }>('/api/shifts', undefined, s).then((r) => r.shifts), []);
  const branches = useBranches();
  const branchName = (id: string | null) => (id ? branches.data?.find((b) => b.id === id)?.name ?? '—' : 'All branches');
  const cols: Column<Shift>[] = [
    { key: 'name', header: 'Shift', cell: (s) => <span className="strong">{s.name}</span> },
    { key: 'time', header: 'Time', cell: (s) => <span className="row num nowrap">{fmtClock(s.start_time)} – {fmtClock(s.end_time)}{s.overnight && <Moon width={14} height={14} aria-label="Overnight" />}</span> },
    { key: 'days', header: 'Days', cell: (s) => fmtDays(s.days_of_week) },
    { key: 'grace', header: 'Grace', className: 'num', cell: (s) => `${s.grace_minutes}m` },
    { key: 'break', header: 'Unpaid break', className: 'num', cell: (s) => (s.unpaid_break_minutes ? `${s.unpaid_break_minutes}m > ${fmtDuration(s.break_applies_after_minutes)}` : '—') },
    { key: 'ot', header: 'OT after', className: 'num', cell: (s) => (s.overtime_after_minutes != null ? fmtDuration(s.overtime_after_minutes) : '—') },
    { key: 'staff', header: 'Staff', className: 'num', cell: (s) => s.employee_count },
    { key: 'status', header: '', cell: (s) => (s.active ? null : <Pill tone="neutral">Inactive</Pill>) },
  ];
  return (
    <>
      <PageHead title="Shifts" lede="Schedules used to work out lateness, absences, breaks and overtime." actions={can('shifts.write') && <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>New shift</Button>} />
      <Card>
        {q.loading && !q.data ? <SkeletonRows rows={3} avatar={false} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data?.length ? (
          <EmptyState icon={CalendarClock} title="No shifts yet" action={can('shifts.write') ? <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Create a shift</Button> : undefined}>Create shifts like “Morning 9am–5pm”, then assign them to staff.</EmptyState>
        ) : (
          <ResponsiveTable
            caption="Shifts"
            rows={q.data}
            columns={(branches.data?.length ?? 0) > 1 ? [...cols.slice(0, 3), { key: 'branch', header: 'Branch', cell: (s) => branchName(s.branch_id) }, ...cols.slice(3)] : cols}
            rowKey={(s) => s.id}
            onRowClick={can('shifts.write') ? (s) => setEditing(s) : undefined}
            card={(s) => (
              <>
                <div className="mcard-row">
                  <span className="strong">{s.name}</span>
                  <span className="row num nowrap small">{fmtClock(s.start_time)} – {fmtClock(s.end_time)}{s.overnight && <Moon width={14} height={14} aria-label="Overnight" />}</span>
                </div>
                <div className="mcard-meta">
                  <span>{fmtDays(s.days_of_week)}</span>
                  <span><span className="k">Grace</span> {s.grace_minutes}m</span>
                  <span><span className="k">Staff</span> {s.employee_count}</span>
                  {!s.active && <span>Inactive</span>}
                </div>
              </>
            )}
          />
        )}
      </Card>
      <ShiftDialog open={editing !== null} shift={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={q.reload} />
    </>
  );
}
