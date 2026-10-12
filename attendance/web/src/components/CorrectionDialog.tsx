import { useEffect, useId, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useEmployees } from '../lib/data';
import type { Session } from '../lib/types';
import { Dialog } from './Dialog';
import { Button, Field, InlineError, Input, Select, TextArea, Toggle, Notice } from './ui';
import { useToast } from './Toast';

export type CorrectionMode = { kind: 'adjust_times'; session: Session } | { kind: 'void_session'; session: Session } | { kind: 'add_session'; employeeId?: string };

/** Request (or, for owners/managers, apply) a timesheet correction. */
export function CorrectionDialog({ mode, onClose, onDone }: { mode: CorrectionMode | null; onClose: () => void; onDone?: () => void }) {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const id = useId();
  const emps = useEmployees('all');
  const canApply = can('corrections.approve');
  const [employeeId, setEmployeeId] = useState('');
  const [inDate, setInDate] = useState('');
  const [inTime, setInTime] = useState('');
  const [outDate, setOutDate] = useState('');
  const [outTime, setOutTime] = useState('');
  const [reason, setReason] = useState('');
  const [applyNow, setApplyNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mode) return;
    setErr(null);
    setReason('');
    setApplyNow(canApply);
    if (mode.kind === 'add_session') {
      setEmployeeId(mode.employeeId ?? '');
      const d = fmt.today();
      setInDate(d);
      setOutDate(d);
      setInTime('09:00');
      setOutTime('17:00');
    } else {
      const s = mode.session;
      const i = fmt.toInputs(s.effective_check_in);
      setInDate(i.date);
      setInTime(i.time);
      if (s.effective_check_out) {
        const o = fmt.toInputs(s.effective_check_out);
        setOutDate(o.date);
        setOutTime(o.time);
      } else {
        setOutDate(i.date);
        setOutTime('');
      }
    }
  }, [mode, canApply, fmt]);

  if (!mode) return null;
  const s = mode.kind !== 'add_session' ? mode.session : null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { kind: mode.kind, reason: reason.trim(), apply_now: canApply && applyNow };
      if (mode.kind === 'add_session') {
        body.employee_id = employeeId;
        body.check_in_at = fmt.toIso(inDate, inTime);
        body.check_out_at = fmt.toIso(outDate, outTime);
      } else if (mode.kind === 'adjust_times') {
        body.session_id = mode.session.id;
        const newIn = fmt.toIso(inDate, inTime);
        if (newIn !== new Date(mode.session.effective_check_in).toISOString()) body.check_in_at = newIn;
        if (outTime) {
          const newOut = fmt.toIso(outDate, outTime);
          if (!mode.session.effective_check_out || newOut !== new Date(mode.session.effective_check_out).toISOString()) body.check_out_at = newOut;
        }
        if (!body.check_in_at && !body.check_out_at) throw new Error('Change the check-in or check-out time first.');
      } else {
        body.session_id = mode.session.id;
      }
      const r = await api.post<{ id: string; status: string }>('/api/corrections', body);
      toast.success(r.status === 'approved' ? 'Correction applied' : 'Correction requested — an owner or manager will review it');
      onDone?.();
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  const titles = { adjust_times: 'Adjust times', void_session: 'Void this session', add_session: 'Add a missing session' };
  const submitLabel = mode.kind === 'void_session' ? (canApply && applyNow ? 'Void session' : 'Request void') : canApply && applyNow ? 'Save correction' : 'Request correction';
  const invalid = reason.trim().length < 3 || (mode.kind === 'add_session' && (!employeeId || !inTime || !outTime)) || (mode.kind === 'adjust_times' && !inTime);
  return (
    <Dialog
      open
      onClose={onClose}
      title={titles[mode.kind]}
      description={s ? `${s.full_name} · ${fmt.date(s.effective_check_in)}` : 'For a shift that was worked but never recorded.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={mode.kind === 'void_session' ? 'danger' : 'primary'} loading={busy} disabled={invalid} onClick={() => void submit()}>{submitLabel}</Button>
        </>
      }
    >
      <div className="stack">
        {mode.kind === 'add_session' && (
          <Field label="Employee" htmlFor={`${id}-e`}>
            <Select id={`${id}-e`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!!mode.employeeId}>
              <option value="">Choose an employee</option>
              {emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.staff_id})</option>)}
            </Select>
          </Field>
        )}
        {mode.kind === 'void_session' ? (
          <Notice tone="warning">Voiding removes this session from hours and reports. The original kiosk events stay in the history for audit.</Notice>
        ) : (
          <>
            {s && (
              <div className="notice">
                <div>
                  Recorded: <strong className="num">{fmt.time(s.check_in_at)}</strong> → <strong className="num">{s.check_out_at ? fmt.time(s.check_out_at) : 'no check-out'}</strong>.
                  {s.is_corrected && ' This session was corrected before.'} Original kiosk times are always kept.
                </div>
              </div>
            )}
            <div className="form-grid">
              <Field label="Check-in date" htmlFor={`${id}-id`}><Input id={`${id}-id`} type="date" value={inDate} max={fmt.today()} onChange={(e) => setInDate(e.target.value)} /></Field>
              <Field label="Check-in time" htmlFor={`${id}-it`}><Input id={`${id}-it`} type="time" value={inTime} onChange={(e) => setInTime(e.target.value)} /></Field>
              <Field label="Check-out date" htmlFor={`${id}-od`}><Input id={`${id}-od`} type="date" value={outDate} max={fmt.today()} onChange={(e) => setOutDate(e.target.value)} /></Field>
              <Field label="Check-out time" htmlFor={`${id}-ot`} help={mode.kind === 'adjust_times' && !s?.effective_check_out ? 'Leave empty to keep the session open.' : undefined}><Input id={`${id}-ot`} type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} /></Field>
            </div>
          </>
        )}
        <Field label="Reason" htmlFor={`${id}-r`} help="Required. Kept with the correction in the audit log.">
          <TextArea id={`${id}-r`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={mode.kind === 'void_session' ? 'e.g. Duplicate entry, employee was off' : 'e.g. Forgot to check out, confirmed by supervisor'} />
        </Field>
        {canApply ? (
          <Toggle checked={applyNow} onChange={setApplyNow} label="Apply immediately" description="Off = save as a request for another owner or manager to approve." />
        ) : (
          <p className="subtle xs">Your request will be sent to an owner or manager for approval.</p>
        )}
        <InlineError>{err}</InlineError>
      </div>
    </Dialog>
  );
}
