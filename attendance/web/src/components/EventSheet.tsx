import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import type { AttendanceEvent } from '../lib/types';
import { eventVerification, flagLabel, SOURCE_LABELS, VERIFICATION_INFO, sessionStatusInfo } from '../lib/status';
import { fmtDuration } from '../lib/format';
import { Dialog } from './Dialog';
import { Button, Direction, ErrorState, Field, InlineError, Person, Skeleton, StatusPill, TextArea, Notice } from './ui';
import { useToast } from './Toast';

export function VerificationPill({ e }: { e: AttendanceEvent }) {
  return <StatusPill info={VERIFICATION_INFO[eventVerification(e)]} />;
}

/** Detail sheet for one attendance event, with Approve / Reject for pending reviews. */
export function EventSheet({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery(
    (s) => api.get<{ events: AttendanceEvent[] }>('/api/events', { id: eventId ?? undefined, limit: 1 }, s).then((r) => r.events[0] ?? null),
    [eventId],
    { enabled: !!eventId, tables: ['attendance_events', 'attendance_sessions'] },
  );
  const e = q.data;

  const decide = async (decision: 'approve' | 'reject') => {
    if (!e) return;
    setBusy(decision);
    setErr(null);
    try {
      await api.post(`/api/events/${e.id}/review`, { decision, note: note.trim() || undefined });
      toast.success(decision === 'approve' ? 'Event approved' : 'Event rejected');
      setNote('');
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(null);
    }
  };

  const pending = e?.verification_status === 'pending_review';
  const canReview = pending && can('attendance.review');
  return (
    <Dialog
      open={!!eventId}
      onClose={onClose}
      side
      title={e ? (e.event_type === 'check_in' ? 'Check-in' : 'Check-out') : 'Attendance event'}
      description={e ? fmt.dateTime(e.event_time) : undefined}
      footer={
        canReview ? (
          <>
            <Button variant="danger-ghost" icon={X} loading={busy === 'reject'} disabled={!!busy} onClick={() => void decide('reject')}>Reject</Button>
            <Button variant="primary" icon={Check} loading={busy === 'approve'} disabled={!!busy} onClick={() => void decide('approve')}>Approve</Button>
          </>
        ) : undefined
      }
    >
      {q.loading && !e ? (
        <div className="stack"><Skeleton h={40} /><Skeleton h={160} /></div>
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !e ? (
        <ErrorState message="This event no longer exists or you don’t have access to it." />
      ) : (
        <div className="stack">
          <div className="row-between">
            <Link to={`/staff/${e.employee_id}`} onClick={onClose} style={{ color: 'inherit', minWidth: 0 }}>
              <Person name={e.full_name} sub={`Staff ID ${e.staff_id}`} employeeId={e.employee_id} hasPhoto={e.has_photo} size="lg" />
            </Link>
          </div>
          <div className="row-wrap">
            <Direction type={e.event_type} />
            <VerificationPill e={e} />
            {e.is_late && e.event_type === 'check_in' && <StatusPill info={{ label: `Late ${e.late_minutes}m`, tone: 'warning' }} />}
            {e.is_corrected && <StatusPill info={{ label: 'Session corrected', tone: 'accent' }} />}
          </div>
          {pending && (
            <Notice tone="attention">
              This event is <strong>awaiting review</strong> and is not counted as verified. {e.exception_flags.length ? `Reason: ${e.exception_flags.map(flagLabel).join(', ')}.` : ''}
            </Notice>
          )}
          <dl className="kv">
            <dt>Time</dt><dd className="num">{fmt.time(e.event_time)} · {fmt.date(e.event_time)}</dd>
            {e.scheduled_start && (<><dt>Scheduled start</dt><dd className="num">{fmt.time(e.scheduled_start)}</dd></>)}
            {e.worked_minutes != null && e.event_type === 'check_out' && (<><dt>Worked</dt><dd className="num">{fmtDuration(e.worked_minutes)}</dd></>)}
            <dt>Method</dt><dd>{SOURCE_LABELS[e.source] ?? e.source}{e.match_score != null ? ` · match ${e.match_score.toFixed(2)}` : ''}</dd>
            <dt>Branch</dt><dd>{e.branch_name ?? '—'}</dd>
            <dt>Kiosk</dt><dd>{e.device_name ?? (e.source === 'manual' ? 'Dashboard' : '—')}</dd>
            <dt>Recorded offline</dt><dd>{e.recorded_offline ? 'Yes' : 'No'}</dd>
            {e.device_timestamp && (<><dt>Device time</dt><dd className="num">{fmt.dateTime(e.device_timestamp)}</dd></>)}
            <dt>Server received</dt><dd className="num">{fmt.dateTime(e.server_received_at)}</dd>
            {e.exception_flags.length > 0 && (<><dt>Flags</dt><dd><div className="row-wrap">{e.exception_flags.map((f) => <span key={f} className="flag">{flagLabel(f)}</span>)}</div></dd></>)}
            {e.note && (<><dt>Note</dt><dd>{e.note}</dd></>)}
            {e.session_status && (<><dt>Session</dt><dd><StatusPill info={sessionStatusInfo({ status: e.session_status })} /></dd></>)}
            {e.reviewed_at && (<><dt>Reviewed</dt><dd>{fmt.dateTime(e.reviewed_at)}{e.review_note ? ` — “${e.review_note}”` : ''}</dd></>)}
          </dl>
          {e.session_id && (
            <Link to={`/attendance?session=${e.session_id}`} onClick={onClose} className="small">Open in timesheets →</Link>
          )}
          {canReview && (
            <Field label="Review note" optional htmlFor="rv-note" help="Saved with your decision in the audit log.">
              <TextArea id="rv-note" value={note} onChange={(x) => setNote(x.target.value)} maxLength={300} placeholder="e.g. Confirmed with the shift lead" />
            </Field>
          )}
          <InlineError>{err}</InlineError>
        </div>
      )}
    </Dialog>
  );
}
