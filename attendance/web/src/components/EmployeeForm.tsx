import { useEffect, useId, useState } from 'react';
import { Check } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useBranches, useShifts } from '../lib/data';
import type { Employee } from '../lib/types';
import { fmtClock, fmtDays } from '../lib/format';
import { Dialog } from './Dialog';
import { Button, Field, InlineError, Select, TextField } from './ui';
import { useToast } from './Toast';

interface FormState {
  full_name: string;
  preferred_name: string;
  staff_id: string;
  job_title: string;
  department: string;
  email: string;
  branch_id: string;
  shift_ids: string[];
  pin: string;
}

const empty: FormState = { full_name: '', preferred_name: '', staff_id: '', job_title: '', department: '', email: '', branch_id: '', shift_ids: [], pin: '' };

export function EmployeeForm({ open, onClose, employee, onSaved }: { open: boolean; onClose: () => void; employee?: Employee | null; onSaved?: (e: Employee) => void }) {
  const toast = useToast();
  const branches = useBranches();
  const shifts = useShifts();
  const id = useId();
  const [f, setF] = useState<FormState>(empty);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setFe({});
    setF(
      employee
        ? {
            full_name: employee.full_name, preferred_name: employee.preferred_name ?? '', staff_id: employee.staff_id, job_title: employee.job_title ?? '',
            department: employee.department ?? '', email: employee.email ?? '', branch_id: employee.branch_id ?? '', shift_ids: employee.shifts.map((s) => s.id), pin: '',
          }
        : { ...empty, branch_id: branches.data?.length === 1 ? branches.data[0].id : '' },
    );
  }, [open, employee, branches.data]);

  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggleShift = (sid: string) => setF((x) => ({ ...x, shift_ids: x.shift_ids.includes(sid) ? x.shift_ids.filter((s) => s !== sid) : [...x.shift_ids, sid] }));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setFe({});
    const body: Record<string, unknown> = {
      full_name: f.full_name.trim(),
      staff_id: f.staff_id.trim(),
      preferred_name: f.preferred_name.trim() || null,
      job_title: f.job_title.trim() || null,
      department: f.department.trim() || null,
      email: f.email.trim() || null,
      branch_id: f.branch_id || null,
      shift_ids: f.shift_ids,
    };
    if (!employee && f.pin) body.pin = f.pin;
    try {
      const r = employee ? await api.patch<{ employee: Employee }>(`/api/employees/${employee.id}`, body) : await api.post<{ employee: Employee }>('/api/employees', body);
      toast.success(employee ? 'Employee updated' : `${r.employee.full_name} added`);
      onClose();
      onSaved?.(r.employee);
    } catch (x) {
      if (x instanceof ApiError) {
        const m: Record<string, string> = {};
        for (const i of x.issues) m[i.path.split('.')[0]] = i.message;
        if (x.code === 'staff_id_taken') m.staff_id = x.message;
        setFe(m);
      }
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  const activeShifts = (shifts.data ?? []).filter((s) => s.active || f.shift_ids.includes(s.id));
  const pinInvalid = !!f.pin && !/^\d{4,8}$/.test(f.pin);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={employee ? 'Edit employee' : 'Add employee'}
      description={employee ? undefined : 'Face enrollment is done later on the kiosk, in Manager mode.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!f.full_name.trim() || !f.staff_id.trim() || pinInvalid} onClick={() => void submit()}>
            {employee ? 'Save changes' : 'Add employee'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <TextField label="Full name" value={f.full_name} onChange={set('full_name')} error={fe.full_name} required autoComplete="off" data-autofocus />
          <TextField label="Preferred name" optional value={f.preferred_name} onChange={set('preferred_name')} error={fe.preferred_name} help="Used in the kiosk greeting." />
          <TextField label="Staff ID" value={f.staff_id} onChange={set('staff_id')} error={fe.staff_id} required help="Letters, numbers, dot, dash or underscore." autoCapitalize="characters" />
          <TextField label="Job title" optional value={f.job_title} onChange={set('job_title')} error={fe.job_title} />
          <TextField label="Department" optional value={f.department} onChange={set('department')} error={fe.department} />
          <TextField label="Email" optional type="email" inputMode="email" value={f.email} onChange={set('email')} error={fe.email} />
          {(branches.data?.length ?? 0) > 0 && (
            <Field label="Branch" htmlFor={`${id}-b`} error={fe.branch_id}>
              <Select id={`${id}-b`} value={f.branch_id} onChange={set('branch_id')}>
                <option value="">No branch</option>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
          {!employee && (
            <TextField label="Kiosk PIN" optional inputMode="numeric" pattern="\d*" maxLength={8} value={f.pin} onChange={set('pin')} error={pinInvalid ? 'PIN must be 4–8 digits' : fe.pin} help="Fallback when face recognition can’t be used." autoComplete="off" />
          )}
        </div>
        <Field label="Shifts" optional help={activeShifts.length ? 'Used to work out lateness, absences and overtime.' : 'No shifts yet — create them on the Shifts page.'}>
          <div className="chips" role="group" aria-label="Shifts">
            {activeShifts.map((s) => {
              const on = f.shift_ids.includes(s.id);
              return (
                <button key={s.id} type="button" className="chip" aria-pressed={on} onClick={() => toggleShift(s.id)} title={`${fmtDays(s.days_of_week)} ${fmtClock(s.start_time)}–${fmtClock(s.end_time)}`}>
                  {on && <Check aria-hidden />}
                  {s.name} <span className="subtle xs">{fmtClock(s.start_time)}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <InlineError>{Object.keys(fe).length ? null : err}</InlineError>
      </div>
    </Dialog>
  );
}
