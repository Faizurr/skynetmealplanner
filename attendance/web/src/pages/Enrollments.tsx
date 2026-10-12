import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ScanFace, X } from 'lucide-react';
import { api } from '../lib/api';
import { useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import type { PendingEnrollment } from '../lib/types';
import { CONSENT_LABELS, enrollmentInfo } from '../lib/status';
import { Avatar, Button, Card, EmptyState, ErrorState, PageHead, SegmentedControl, SkeletonRows, StatusPill, Notice } from '../components/ui';
import { ConfirmDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

type Status = 'pending_confirmation' | 'active' | 'deleted';

export function EnrollmentsPage() {
  const fmt = useFmt();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('pending_confirmation');
  const [action, setAction] = useState<{ kind: 'confirm' | 'reject'; e: PendingEnrollment } | null>(null);
  const q = useQuery((s) => api.get<{ enrollments: PendingEnrollment[] }>('/api/enrollments', { status }, s).then((r) => r.enrollments), [status], { tables: ['face_enrollments'] });
  return (
    <>
      <PageHead title="Face enrollments" lede="New face enrollments must be confirmed by you before the kiosk will recognise that person." />
      <div className="filters">
        <SegmentedControl<Status> label="Enrollment status" value={status} onChange={setStatus} options={[{ value: 'pending_confirmation', label: 'Awaiting confirmation' }, { value: 'active', label: 'Active' }, { value: 'deleted', label: 'Deleted' }]} />
      </div>
      <div className="stack">
        <Notice icon={ScanFace}>Enrollment happens on the kiosk in <strong>Manager mode</strong>. Check that the photo (if one was saved) and the name match the real person before confirming.</Notice>
        <Card>
          {q.loading && !q.data ? <SkeletonRows rows={3} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data?.length ? (
            <EmptyState icon={ScanFace} title={status === 'pending_confirmation' ? 'Nothing to confirm' : 'No enrollments here'}>
              {status === 'pending_confirmation' ? 'When a manager enrolls a face on the kiosk without confirming it, it shows up here.' : undefined}
            </EmptyState>
          ) : (
            <div className="list">
              {q.data.map((e) => (
                <div className="list-item rich" key={e.id}>
                  <Avatar name={e.full_name} employeeId={e.employee_id} hasPhoto={e.has_photo} size="lg" />
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <Link to={`/staff/${e.employee_id}`} className="strong" style={{ color: 'var(--text)' }}>{e.full_name}</Link>
                    <span className="subtle xs">Staff ID {e.staff_id} · {e.template_count} samples · {fmt.dateTime(e.created_at)}</span>
                    <span className="subtle xs">Consent: {e.consent_method ? CONSENT_LABELS[e.consent_method] ?? e.consent_method : '—'} · Enrolled by {e.enrolled_by ?? '—'}{e.device_name ? ` on ${e.device_name}` : ''}</span>
                    {!e.has_photo && <span className="subtle xs">No reference photo was saved.</span>}
                  </div>
                  {status === 'pending_confirmation' ? (
                    <div className="actions">
                      <Button variant="danger-ghost" icon={X} onClick={() => setAction({ kind: 'reject', e })}>Reject</Button>
                      <Button variant="primary" icon={Check} onClick={() => setAction({ kind: 'confirm', e })}>Confirm identity</Button>
                    </div>
                  ) : (
                    <div className="actions"><StatusPill info={enrollmentInfo(e)} /></div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={!!action}
        onClose={() => setAction(null)}
        danger={action?.kind === 'reject'}
        title={action?.kind === 'confirm' ? `Confirm this is ${action.e.full_name}?` : `Reject enrollment for ${action?.e.full_name}?`}
        confirmLabel={action?.kind === 'confirm' ? 'Yes, confirm identity' : 'Reject and delete'}
        description={action?.kind === 'confirm' ? 'The kiosk will start recognising this face as this employee.' : 'The captured face templates are deleted. The employee can be enrolled again on the kiosk.'}
        onConfirm={async () => {
          if (!action) return;
          await api.post(`/api/enrollments/${action.e.id}/${action.kind}`);
          toast.success(action.kind === 'confirm' ? 'Identity confirmed' : 'Enrollment rejected');
          q.reload();
        }}
      />
    </>
  );
}
