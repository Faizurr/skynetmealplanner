import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ClipboardCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import type { Correction } from '../lib/types';
import { Button, Card, EmptyState, ErrorState, PageHead, SegmentedControl, SkeletonRows, StatusPill } from '../components/ui';
import { ConfirmDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

type Status = 'requested' | 'approved' | 'rejected' | 'all';
const KIND: Record<string, string> = { adjust_times: 'Adjust times', add_session: 'Add missing session', void_session: 'Void session' };

export function CorrectionsPage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('requested');
  const [action, setAction] = useState<{ d: 'approve' | 'reject'; c: Correction } | null>(null);
  const q = useQuery((s) => api.get<{ corrections: Correction[] }>('/api/corrections', { status }, s).then((r) => r.corrections), [status], { tables: ['attendance_sessions'] });

  const change = (c: Correction) => {
    const o = c.original_values ?? {};
    const n = c.new_values ?? { check_in_at: null, check_out_at: null };
    const origIn = (o.corrected_check_in_at ?? o.check_in_at) as string | null | undefined;
    const origOut = (o.corrected_check_out_at ?? o.check_out_at) as string | null | undefined;
    if (c.kind === 'void_session') return origIn ? `Session ${fmt.dateTime(origIn)} → voided` : 'Session voided';
    if (c.kind === 'add_session') return `${fmt.dateTime(n.check_in_at)} → ${fmt.time(n.check_out_at)}`;
    const parts: string[] = [];
    if (n.check_in_at) parts.push(`In ${origIn ? fmt.time(origIn) : '—'} → ${fmt.time(n.check_in_at)}`);
    if (n.check_out_at) parts.push(`Out ${origOut ? fmt.time(origOut) : 'none'} → ${fmt.time(n.check_out_at)}`);
    return `${origIn ? fmt.date(origIn) + ': ' : ''}${parts.join(' · ')}`;
  };

  return (
    <>
      <PageHead title="Corrections" lede="Requested changes to timesheets. Original kiosk records are never overwritten." />
      <div className="filters">
        <SegmentedControl<Status> label="Correction status" value={status} onChange={setStatus} options={[{ value: 'requested', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} />
      </div>
      <Card>
        {q.loading && !q.data ? <SkeletonRows rows={4} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data?.length ? (
          <EmptyState icon={ClipboardCheck} title={status === 'requested' ? 'No pending corrections' : 'Nothing here'}>{status === 'requested' ? 'Correction requests from your team will appear here.' : undefined}</EmptyState>
        ) : (
          <div className="list">
            {q.data.map((c) => (
              <div className="list-item rich no-icon" key={c.id}>
                <div className="stack-sm" style={{ gap: 4 }}>
                  <div className="row-wrap">
                    <Link to={`/staff/${c.employee_id}`} className="strong" style={{ color: 'var(--text)' }}>{c.full_name}</Link>
                    <span className="subtle xs">{c.staff_id}</span>
                    <StatusPill info={{ label: c.status === 'requested' ? 'Pending' : c.status === 'approved' ? 'Approved' : 'Rejected', tone: c.status === 'requested' ? 'attention' : c.status === 'approved' ? 'success' : 'error' }} />
                  </div>
                  <span className="small"><strong>{KIND[c.kind]}</strong> · <span className="num">{change(c)}</span></span>
                  <span className="small muted">“{c.reason}”</span>
                  <span className="subtle xs">Requested by {c.requested_by ?? '—'} · {fmt.dateTime(c.created_at)}{c.decided_at ? ` · ${c.status} by ${c.decided_by ?? '—'} ${fmt.dateTime(c.decided_at)}` : ''}</span>
                  {c.session_id && <Link className="small" to={`/attendance?session=${c.session_id}`}>View session</Link>}
                </div>
                {c.status === 'requested' && can('corrections.approve') && (
                  <div className="actions">
                    <Button variant="danger-ghost" size="sm" icon={X} onClick={() => setAction({ d: 'reject', c })}>Reject</Button>
                    <Button variant="primary" size="sm" icon={Check} onClick={() => setAction({ d: 'approve', c })}>Approve</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!action}
        onClose={() => setAction(null)}
        danger={action?.d === 'reject'}
        title={action?.d === 'approve' ? 'Approve correction?' : 'Reject correction?'}
        confirmLabel={action?.d === 'approve' ? 'Approve & apply' : 'Reject'}
        description={action ? `${action.c.full_name} · ${KIND[action.c.kind]}` : undefined}
        note={{ label: 'Note' }}
        onConfirm={async (note) => {
          if (!action) return;
          await api.post(`/api/corrections/${action.c.id}/${action.d}`, { note: note || undefined });
          toast.success(action.d === 'approve' ? 'Correction applied' : 'Correction rejected');
          q.reload();
        }}
      />
    </>
  );
}
