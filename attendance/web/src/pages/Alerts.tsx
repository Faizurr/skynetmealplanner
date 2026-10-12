import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCircle2, Clock, ScanFace, Tablet, TimerOff, UserX, WifiOff, AlertTriangle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import type { AlertRow } from '../lib/types';
import { exceptionTitle, severityTone } from '../lib/status';
import { Button, Card, EmptyState, ErrorState, PageHead, SegmentedControl, SkeletonRows, Pill } from '../components/ui';
import { ConfirmDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

const ICONS: Record<string, LucideIcon> = {
  late_arrival: Clock, missing_checkout: TimerOff, unknown_face: ScanFace, offline_conflict: AlertTriangle, clock_skew: Clock,
  device_offline: WifiOff, sync_failure: Tablet, identity_mismatch: UserX, overtime: Clock,
};

const KIND_TONE: Record<string, 'warning' | 'error' | 'attention'> = {
  late_arrival: 'warning', missing_checkout: 'warning', overtime: 'warning', device_offline: 'error', sync_failure: 'error',
  unknown_face: 'attention', identity_mismatch: 'attention', offline_conflict: 'attention', clock_skew: 'attention',
};

function describe(a: AlertRow, fmt: ReturnType<typeof useFmt>): string {
  const d = (a.details ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'late_arrival':
      return `${a.full_name ?? 'Employee'} checked in ${d.late_minutes ?? '?'} min late${d.scheduled_start ? ` (due ${fmt.time(String(d.scheduled_start))})` : ''}.`;
    case 'missing_checkout':
      return `${a.full_name ?? 'Employee'} didn’t check out. Fix the session so hours are correct.`;
    case 'unknown_face':
      return `Someone tried to ${d.action === 'check_out' ? 'check out' : 'check in'} at ${a.device_name ?? 'a kiosk'} but wasn’t recognised. No image is stored.`;
    case 'offline_conflict':
      return `${a.full_name ?? 'An employee'}’s offline event needs a decision${Array.isArray(d.flags) ? ` (${(d.flags as string[]).join(', ').replace(/_/g, ' ')})` : ''}.`;
    case 'clock_skew':
      return `${a.device_name ?? 'A kiosk'} reported a time far from the real time. Check its date & time settings.`;
    case 'device_offline':
      return `${a.device_name ?? 'A kiosk'} stopped reporting. Check power and Wi-Fi.`;
    case 'sync_failure':
      return `${a.device_name ?? 'A kiosk'} couldn’t upload an event${d.code ? ` (${String(d.code).replace(/_/g, ' ')})` : ''}.`;
    case 'identity_mismatch':
      return `The kiosk and server disagreed about who this was. Nothing was recorded.`;
    case 'overtime':
      return `${a.full_name ?? 'Employee'} worked overtime${d.overtime_minutes ? ` (${d.overtime_minutes} min)` : ''}.`;
    default:
      return a.full_name ?? a.device_name ?? '';
  }
}

export function AlertsPage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [resolving, setResolving] = useState<AlertRow | null>(null);
  const q = useQuery((s) => api.get<{ exceptions: AlertRow[] }>('/api/exceptions', { status }, s).then((r) => r.exceptions), [status], { tables: ['attendance_exceptions'] });
  return (
    <>
      <PageHead title="Alerts" lede="Things that may need a decision: lateness, missing check-outs and kiosk problems." />
      <div className="filters">
        <SegmentedControl label="Alert status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
      </div>
      <Card>
        {q.loading && !q.data ? <SkeletonRows rows={5} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data?.length ? (
          <EmptyState icon={status === 'open' ? CheckCircle2 : Bell} title={status === 'open' ? 'No open alerts' : 'Nothing here yet'}>{status === 'open' ? 'You’re all caught up.' : undefined}</EmptyState>
        ) : (
          <div className="list">
            {q.data.map((a) => {
              const Icon = ICONS[a.kind] ?? Bell;
              const tone = a.status === 'resolved' ? 'neutral' : a.severity === 'critical' ? 'error' : KIND_TONE[a.kind] ?? severityTone(a.severity);
              return (
                <div className="list-item rich" key={a.id}>
                  <span className={`attention-icon tone-${tone}`}><Icon aria-hidden /></span>
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <div className="row-wrap">
                      <span className="strong">{exceptionTitle(a.kind)}</span>
                      {a.severity === 'critical' && a.status === 'open' && <Pill tone="error">Critical</Pill>}
                      {a.status === 'resolved' && <Pill tone="success">Resolved</Pill>}
                    </div>
                    <span className="small muted">{describe(a, fmt)}</span>
                    <span className="subtle xs">{fmt.dateTime(a.created_at)}{a.staff_id ? ` · ${a.staff_id}` : ''}{a.resolved_at ? ` · resolved ${fmt.dateTime(a.resolved_at)}${a.resolution_note ? ` — “${a.resolution_note}”` : ''}` : ''}</span>
                    <div className="row-wrap small">
                      {a.event_id && <Link to={`/live?event=${a.event_id}`}>View event</Link>}
                      {a.session_id && <Link to={`/attendance?session=${a.session_id}`}>View session</Link>}
                      {a.device_id && <Link to="/devices">View kiosk</Link>}
                      {a.employee_id && !a.event_id && !a.session_id && <Link to={`/staff/${a.employee_id}`}>View employee</Link>}
                    </div>
                  </div>
                  {a.status === 'open' && can('attendance.review') && <div className="actions"><Button size="sm" onClick={() => setResolving(a)}>Resolve</Button></div>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!resolving}
        onClose={() => setResolving(null)}
        title={resolving ? `Resolve “${exceptionTitle(resolving.kind)}”?` : ''}
        confirmLabel="Mark resolved"
        note={{ label: 'Note', placeholder: 'What did you do about it?' }}
        onConfirm={async (note) => {
          if (!resolving) return;
          await api.post(`/api/exceptions/${resolving.id}/resolve`, { note: note || undefined });
          toast.success('Alert resolved');
          q.reload();
        }}
      />
    </>
  );
}
