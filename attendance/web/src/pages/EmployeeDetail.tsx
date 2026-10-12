import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Download, KeyRound, PauseCircle, PencilLine, PlayCircle, ScanFace, Trash2, UserCheck, UserX, CalendarPlus } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import type { Correction, Employee, EnrollmentHistory, Session } from '../lib/types';
import { CONSENT_LABELS, EMPLOYEE_STATUS, enrollmentInfo, sessionStatusInfo } from '../lib/status';
import { addDaysYmd, fmtClock, fmtDuration, fmtHours, fmtYmd } from '../lib/format';
import { Avatar, Button, Card, EmptyState, ErrorState, Notice, Pill, Skeleton, SkeletonRows, StatusPill, TextField, InlineError } from '../components/ui';
import { ResponsiveTable, type Column } from '../components/ResponsiveTable';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { EmployeeForm } from '../components/EmployeeForm';
import { ManualAttendanceDialog } from '../components/ManualAttendanceDialog';
import { CorrectionDialog, type CorrectionMode } from '../components/CorrectionDialog';
import { LineChart } from '../components/Charts';
import { useToast } from '../components/Toast';
import { TimeCell } from './Attendance';
import { errorMessage } from '../lib/api';

type SessionLite = Omit<Session, 'employee_id' | 'full_name' | 'staff_id' | 'branch_name' | 'effective_check_in' | 'effective_check_out'>;

function weekStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Mon
  return addDaysYmd(ymd, -dow);
}

function PinDialog({ open, onClose, employee, onDone }: { open: boolean; onClose: () => void; employee: Employee; onDone: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (value: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/employees/${employee.id}/pin`, { pin: value });
      toast.success(value ? 'PIN saved' : 'PIN removed');
      setPin('');
      onDone();
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const invalid = !/^\d{4,8}$/.test(pin);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={employee.has_pin ? 'Change kiosk PIN' : 'Set kiosk PIN'}
      description="The PIN is a fallback when face recognition can’t be used. Share it privately with the employee."
      footer={
        <>
          {employee.has_pin && <Button variant="danger-ghost" disabled={busy} onClick={() => void save(null)}>Remove PIN</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={() => void save(pin)}>Save PIN</Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="New PIN" inputMode="numeric" pattern="\d*" maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} help="4–8 digits." />
        <InlineError>{err}</InlineError>
      </div>
    </Dialog>
  );
}

export function EmployeePage() {
  const { id = '' } = useParams();
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const today = fmt.today();
  const from = addDaysYmd(today, -55);
  const [edit, setEdit] = useState(false);
  const [manual, setManual] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'suspend' | 'reactivate' | 'deactivate' | 'biometrics'>(null);
  const [correction, setCorrection] = useState<CorrectionMode | null>(null);

  const emp = useQuery((s) => api.get<{ employee: Employee; enrollments: EnrollmentHistory[] }>(`/api/employees/${id}`, undefined, s), [id], { tables: ['employees', 'face_enrollments', 'attendance_sessions'] });
  const att = useQuery((s) => api.get<{ sessions: SessionLite[]; corrections: Correction[] }>(`/api/employees/${id}/attendance`, { from, to: today }, s), [id, from, today], { tables: ['attendance_sessions'] });
  const e = emp.data?.employee;

  const stats = useMemo(() => {
    const sessions = (att.data?.sessions ?? []).filter((s) => s.status !== 'voided');
    const weeks = new Map<string, number>();
    for (let i = 7; i >= 0; i--) weeks.set(weekStart(addDaysYmd(today, -7 * i)), 0);
    for (const s of sessions) {
      const k = weekStart(fmt.ymdOf(s.corrected_check_in_at ?? s.check_in_at));
      if (weeks.has(k)) weeks.set(k, (weeks.get(k) ?? 0) + (s.worked_minutes ?? 0));
    }
    const scheduled = sessions.filter((s) => s.scheduled_start);
    const onTime = scheduled.filter((s) => !s.is_late).length;
    const last30 = sessions.filter((s) => fmt.ymdOf(s.check_in_at) >= addDaysYmd(today, -29));
    return {
      weeks: [...weeks.entries()].map(([k, v]) => ({ key: k, label: fmtYmd(k, { year: false }), value: Math.round((v / 60) * 10) / 10, tip: <>Week of {fmtYmd(k)}: <strong>{fmtHours(v)}</strong> worked</> })),
      punctuality: scheduled.length ? Math.round((onTime / scheduled.length) * 1000) / 10 : null,
      lateCount: scheduled.length - onTime,
      scheduledCount: scheduled.length,
      worked30: last30.reduce((a, s) => a + (s.worked_minutes ?? 0), 0),
      missing: sessions.filter((s) => s.status === 'missing_checkout').length,
    };
  }, [att.data, today, fmt]);

  if (emp.error) return <Card><ErrorState message={emp.error} onRetry={emp.reload} /></Card>;
  if (!e) {
    return (
      <div className="stack" aria-busy="true">
        <Skeleton w={120} h={14} />
        <div className="row"><Skeleton w={64} h={64} r={32} /><div className="grow stack-sm"><Skeleton w="40%" h={22} /><Skeleton w="25%" h={12} /></div></div>
        <Skeleton h={160} r={16} />
      </div>
    );
  }

  const setStatus = async (status: 'active' | 'suspended' | 'deactivated') => {
    await api.post(`/api/employees/${e.id}/status`, { status, delete_biometrics: true });
    toast.success(status === 'active' ? 'Employee reactivated' : status === 'suspended' ? 'Employee suspended' : 'Employee deactivated');
    emp.reload();
  };

  const sessionCols: Column<SessionLite>[] = [
    { key: 'date', header: 'Date', cell: (s) => <span className="nowrap">{fmt.dayShort(s.corrected_check_in_at ?? s.check_in_at)}</span> },
    { key: 'in', header: 'In', cell: (s) => <TimeCell effective={s.corrected_check_in_at ?? s.check_in_at} original={s.check_in_at} corrected={!!s.corrected_check_in_at} /> },
    { key: 'out', header: 'Out', cell: (s) => <TimeCell effective={s.corrected_check_out_at ?? s.check_out_at} original={s.check_out_at} corrected={!!s.corrected_check_out_at} /> },
    { key: 'shift', header: 'Shift', cell: (s) => s.shift_name ?? <span className="subtle">Unscheduled</span> },
    { key: 'late', header: 'Late', className: 'num', cell: (s) => (s.is_late ? `${s.late_minutes}m` : '—') },
    { key: 'worked', header: 'Worked', className: 'num', cell: (s) => fmtDuration(s.worked_minutes) },
    { key: 'status', header: 'Status', cell: (s) => <span className="row-wrap"><StatusPill info={sessionStatusInfo(s)} />{s.is_corrected && <Pill tone="accent" dot={false}>Corrected</Pill>}</span> },
  ];

  const enr = emp.data!.enrollments;
  return (
    <>
      <Link to="/staff" className="back-link"><ChevronLeft aria-hidden />Staff</Link>
      <div className="page-head">
        <div className="profile-head grow">
          <Avatar name={e.full_name} employeeId={e.id} hasPhoto={e.has_photo} size="xl" />
          <div className="stack-sm" style={{ gap: 6 }}>
            <h1>{e.full_name}{e.preferred_name && e.preferred_name !== e.full_name ? <span className="subtle" style={{ fontWeight: 400 }}> · “{e.preferred_name}”</span> : null}</h1>
            <div className="muted small">{[e.staff_id, e.job_title, e.department, e.branch_name].filter(Boolean).join(' · ')}</div>
            <div className="row-wrap">
              <StatusPill info={EMPLOYEE_STATUS[e.status]} />
              <StatusPill info={enrollmentInfo(e.enrollment)} />
              {e.open_session && <Pill tone="success">Working since {fmt.time(e.open_session.check_in_at)}</Pill>}
              {e.has_pin && <Pill tone="neutral" dot={false}><KeyRound aria-hidden />PIN set</Pill>}
            </div>
          </div>
        </div>
        <div className="page-actions">
          {can('employees.write') && <Button icon={PencilLine} onClick={() => setEdit(true)}>Edit</Button>}
          {can('attendance.manual') && e.status === 'active' && <Button variant="primary" icon={UserCheck} onClick={() => setManual(true)}>{e.open_session ? 'Check out' : 'Check in'}</Button>}
        </div>
      </div>

      <div className="grid grid-sidebar">
        <div className="stack">
          <Card title="Last 8 weeks" hint="Worked hours per week (Mon–Sun)">
            <div className="card-body stack">
              {att.loading && !att.data ? <Skeleton h={160} /> : att.error ? <ErrorState message={att.error} onRetry={att.reload} /> : (
                <>
                  <div className="stat-inline">
                    <div><div className="v">{fmtHours(stats.worked30)}</div><div className="l">Worked, last 30 days</div></div>
                    <div><div className="v">{stats.punctuality == null ? '—' : `${stats.punctuality}%`}</div><div className="l">On time ({stats.scheduledCount} shifts)</div></div>
                    <div><div className="v">{stats.lateCount}</div><div className="l">Late arrivals</div></div>
                    <div><div className="v">{stats.missing}</div><div className="l">Missing check-outs</div></div>
                  </div>
                  <LineChart points={stats.weeks} label={`Worked hours per week for ${e.full_name}`} yFormat={(v) => `${v}h`} />
                </>
              )}
            </div>
          </Card>

          <Card title="Attendance history" hint="Last 8 weeks" actions={<>
            {can('corrections.request') && <Button size="sm" icon={CalendarPlus} onClick={() => setCorrection({ kind: 'add_session', employeeId: e.id })}>Add session</Button>}
            <Link className="btn btn-sm btn-ghost" to={`/attendance?employee=${e.id}`}>Timesheets</Link>
          </>}>
            {att.loading && !att.data ? <SkeletonRows rows={4} avatar={false} /> : !att.data?.sessions.length ? (
              <EmptyState title="No attendance yet">Sessions appear here once {e.preferred_name ?? e.full_name.split(' ')[0]} checks in.</EmptyState>
            ) : (
              <ResponsiveTable
                rows={att.data.sessions.slice(0, 30)}
                columns={sessionCols}
                rowKey={(s) => s.id}
                onRowClick={(s) => nav(`/attendance?session=${s.id}&employee=${e.id}`)}
                card={(s) => (
                  <div className="mcard-row">
                    <span className="stack-sm" style={{ gap: 2 }}>
                      <span className="strong small">{fmt.dayShort(s.corrected_check_in_at ?? s.check_in_at)}</span>
                      <span className="row small num">
                        <TimeCell effective={s.corrected_check_in_at ?? s.check_in_at} original={s.check_in_at} corrected={!!s.corrected_check_in_at} />
                        <span className="subtle">→</span>
                        <TimeCell effective={s.corrected_check_out_at ?? s.check_out_at} original={s.check_out_at} corrected={!!s.corrected_check_out_at} />
                      </span>
                    </span>
                    <span className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}>
                      <span className="strong num">{fmtDuration(s.worked_minutes)}</span>
                      <span className="row-wrap" style={{ justifyContent: 'flex-end' }}>{s.is_late && <Pill tone="warning">Late {s.late_minutes}m</Pill>}<StatusPill info={sessionStatusInfo(s)} /></span>
                    </span>
                  </div>
                )}
              />
            )}
          </Card>

          {!!att.data?.corrections.length && (
            <Card title="Corrections">
              <div className="list">
                {att.data.corrections.map((c) => (
                  <div className="list-item" key={c.id}>
                    <span className="grow">
                      <span className="strong small" style={{ display: 'block' }}>{c.kind === 'adjust_times' ? 'Adjusted times' : c.kind === 'add_session' ? 'Added session' : 'Voided session'}</span>
                      <span className="subtle xs" style={{ display: 'block' }}>“{c.reason}” · {c.requested_by ?? 'Someone'} · {fmt.dateTime(c.created_at)}</span>
                    </span>
                    <StatusPill info={{ label: c.status === 'requested' ? 'Pending' : c.status === 'approved' ? 'Approved' : 'Rejected', tone: c.status === 'requested' ? 'attention' : c.status === 'approved' ? 'success' : 'error' }} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="stack">
          <Card title="Profile">
            <div className="card-body">
              <dl className="kv">
                <dt>Staff ID</dt><dd>{e.staff_id}</dd>
                <dt>Email</dt><dd>{e.email ?? '—'}</dd>
                <dt>Branch</dt><dd>{e.branch_name ?? '—'}</dd>
                <dt>Shifts</dt>
                <dd>{e.shifts.length ? e.shifts.map((s) => <div key={s.id}>{s.name} <span className="subtle">{fmtClock(s.start_time.slice(0, 5))}–{fmtClock(s.end_time.slice(0, 5))}</span></div>) : 'None assigned'}</dd>
                <dt>Today</dt><dd>{e.open_session ? `Checked in at ${fmt.time(e.open_session.check_in_at)}` : 'Not checked in'}</dd>
              </dl>
            </div>
          </Card>

          <Card title="Face enrollment">
            <div className="card-body stack">
              <div className="row-between"><StatusPill info={enrollmentInfo(e.enrollment)} />{e.enrollment && <span className="subtle xs">{e.enrollment.template_count} templates</span>}</div>
              {!e.enrollment && (
                <Notice icon={ScanFace}>Faces are enrolled on the kiosk: tap <strong>Manager mode</strong>, sign in with your dashboard account, choose {e.preferred_name ?? e.full_name.split(' ')[0]} and follow the prompts. Record their consent first.</Notice>
              )}
              {e.enrollment?.status === 'pending_confirmation' && can('biometrics.manage') && (
                <Notice tone="attention">This enrollment is waiting for you to confirm the person’s identity. <Link to="/enrollments">Review now →</Link></Notice>
              )}
              {enr.length > 0 && (
                <div className="stack-sm">
                  <div className="subtle xs strong">History</div>
                  {enr.map((x) => (
                    <div key={x.id} className="small" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                      <div className="row-between"><span className="strong">{fmt.date(x.created_at)}</span><StatusPill info={enrollmentInfo(x)} dot={false} /></div>
                      <div className="subtle xs">
                        Consent: {x.consent_method ? CONSENT_LABELS[x.consent_method] ?? x.consent_method : '—'}{x.consent_notice_version ? ` (notice ${x.consent_notice_version})` : ''}
                        <br />Enrolled by {x.enrolled_by ?? '—'}{x.confirmed_by ? ` · confirmed by ${x.confirmed_by}` : ''}{x.deleted_at ? ` · deleted ${fmt.date(x.deleted_at)}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {can('biometrics.manage') && e.enrollment && (
                <Button variant="danger-ghost" icon={Trash2} onClick={() => setConfirm('biometrics')}>Delete biometric data</Button>
              )}
            </div>
          </Card>

          {can('employees.write') && (
            <Card title="Manage">
              <div className="card-body stack-sm">
                <Button icon={KeyRound} onClick={() => setPinOpen(true)} disabled={e.status === 'deactivated'}>{e.has_pin ? 'Change or remove PIN' : 'Set kiosk PIN'}</Button>
                <Button icon={Download} onClick={() => downloadFile(`/api/employees/${e.id}/export`, undefined, `employee-${e.staff_id}-data.json`).then((n) => toast.success(`Downloaded ${n}`)).catch(toast.error)}>Export personal data (JSON)</Button>
                {e.status === 'active' && <Button icon={PauseCircle} onClick={() => setConfirm('suspend')}>Suspend</Button>}
                {e.status !== 'active' && <Button icon={PlayCircle} onClick={() => setConfirm('reactivate')}>Reactivate</Button>}
                {e.status !== 'deactivated' && <Button variant="danger-ghost" icon={UserX} onClick={() => setConfirm('deactivate')}>Deactivate (offboard)</Button>}
              </div>
            </Card>
          )}
        </div>
      </div>

      <EmployeeForm open={edit} onClose={() => setEdit(false)} employee={e} onSaved={() => emp.reload()} />
      <ManualAttendanceDialog open={manual} onClose={() => setManual(false)} employeeId={e.id} defaultAction={e.open_session ? 'check_out' : 'check_in'} />
      <PinDialog open={pinOpen} onClose={() => setPinOpen(false)} employee={e} onDone={emp.reload} />
      <CorrectionDialog mode={correction} onClose={() => setCorrection(null)} onDone={att.reload} />
      <ConfirmDialog open={confirm === 'suspend'} onClose={() => setConfirm(null)} title={`Suspend ${e.full_name}?`} confirmLabel="Suspend" description="They won’t be able to check in at the kiosk until reactivated. Their face data and history are kept." onConfirm={() => setStatus('suspended')} />
      <ConfirmDialog open={confirm === 'reactivate'} onClose={() => setConfirm(null)} title={`Reactivate ${e.full_name}?`} confirmLabel="Reactivate" description={e.status === 'deactivated' ? 'They can check in again. If their face data was deleted at deactivation, enroll them again on the kiosk.' : 'They can check in at the kiosk again.'} onConfirm={() => setStatus('active')} />
      <ConfirmDialog
        open={confirm === 'deactivate'}
        onClose={() => setConfirm(null)}
        danger
        title={`Deactivate ${e.full_name}?`}
        confirmLabel="Deactivate"
        description="Use this when someone leaves. They can no longer check in. Their face templates and reference photo will be permanently deleted, because biometric data must not be kept after employment ends. Attendance history is kept for payroll records."
        onConfirm={() => setStatus('deactivated')}
      />
      <ConfirmDialog
        open={confirm === 'biometrics'}
        onClose={() => setConfirm(null)}
        danger
        title="Delete biometric data?"
        confirmLabel="Delete permanently"
        typeToConfirm="DELETE"
        description={`This permanently deletes ${e.full_name}’s encrypted face templates and reference photo. It cannot be undone. Attendance history is kept. They’ll need to be enrolled again on the kiosk to use face check-in.`}
        onConfirm={async () => {
          await api.del(`/api/employees/${e.id}/biometrics`);
          toast.success('Biometric data deleted');
          emp.reload();
        }}
      />
    </>
  );
}
