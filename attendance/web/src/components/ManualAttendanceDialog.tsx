import { useEffect, useId, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useFmt } from '../lib/auth';
import { useEmployees } from '../lib/data';
import { Dialog } from './Dialog';
import { Button, Field, InlineError, Input, Select, TextArea, SegmentedControl, Notice } from './ui';
import { useToast } from './Toast';

interface Result {
  result: 'recorded' | 'duplicate' | 'pending_review';
  employee: { full_name: string };
  display: { headline: string; time: string };
}

/** Owner-assisted check-in / check-out (kiosk broken, face not recognised…). */
export function ManualAttendanceDialog({ open, onClose, employeeId, defaultAction }: { open: boolean; onClose: () => void; employeeId?: string; defaultAction?: 'check_in' | 'check_out' }) {
  const fmt = useFmt();
  const toast = useToast();
  const emps = useEmployees('active');
  const id = useId();
  const [emp, setEmp] = useState(employeeId ?? '');
  const [action, setAction] = useState<'check_in' | 'check_out'>(defaultAction ?? 'check_in');
  const [when, setWhen] = useState<'now' | 'earlier'>('now');
  const [date, setDate] = useState(fmt.today());
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmp(employeeId ?? '');
    setNote('');
    setErr(null);
    setWhen('now');
    const nowParts = fmt.toInputs(new Date().toISOString());
    setDate(nowParts.date);
    setTime(nowParts.time);
    setAction(defaultAction ?? 'check_in');
  }, [open, employeeId, defaultAction, fmt]);

  // Suggest the right action from the employee's open session.
  useEffect(() => {
    if (!emp || defaultAction) return;
    const e = emps.data?.find((x) => x.id === emp);
    if (e) setAction(e.open_session ? 'check_out' : 'check_in');
  }, [emp, emps.data, defaultAction]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { employee_id: emp, action, note: note.trim() };
      if (when === 'earlier') body.time = fmt.toIso(date, time);
      const r = await api.post<Result>('/api/attendance/manual', body);
      toast.success(r.result === 'duplicate' ? 'Already recorded' : `${r.employee.full_name}: ${action === 'check_in' ? 'checked in' : 'checked out'} at ${r.display.time}`);
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const selected = emps.data?.find((x) => x.id === emp);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record attendance manually"
      description="Use when the kiosk can’t be used. Manual entries are labelled and audited."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!emp || note.trim().length < 3 || (when === 'earlier' && (!date || !time))} onClick={() => void submit()}>
            {action === 'check_in' ? 'Record check-in' : 'Record check-out'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Employee" htmlFor={`${id}-e`}>
          <Select id={`${id}-e`} value={emp} onChange={(e) => setEmp(e.target.value)} disabled={!!employeeId}>
            <option value="">{emps.loading ? 'Loading…' : 'Choose an employee'}</option>
            {emps.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} ({e.staff_id}){e.open_session ? ' · working' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {selected?.open_session && action === 'check_in' && <Notice tone="warning">{selected.full_name} is already checked in since {fmt.time(selected.open_session.check_in_at)}.</Notice>}
        <Field label="Action">
          <SegmentedControl block label="Action" value={action} onChange={setAction} options={[{ value: 'check_in', label: 'Check in' }, { value: 'check_out', label: 'Check out' }]} />
        </Field>
        <Field label="When">
          <SegmentedControl block label="When" value={when} onChange={setWhen} options={[{ value: 'now', label: 'Now' }, { value: 'earlier', label: 'Earlier time' }]} />
        </Field>
        {when === 'earlier' && (
          <div className="form-grid">
            <Field label="Date" htmlFor={`${id}-d`}><Input id={`${id}-d`} type="date" value={date} max={fmt.today()} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={`Time (${fmt.tz.split('/').pop()?.replace(/_/g, ' ')})`} htmlFor={`${id}-t`}><Input id={`${id}-t`} type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          </div>
        )}
        <Field label="Reason" htmlFor={`${id}-n`} help="Required (at least 3 characters). Shown on the event and in the audit log.">
          <TextArea id={`${id}-n`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Kiosk tablet was charging" />
        </Field>
        <InlineError>{err}</InlineError>
      </div>
    </Dialog>
  );
}
