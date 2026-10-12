import { useEffect, useRef, useState } from 'react';
import { Mail, Plus, RefreshCw, Send, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth, useFmt } from '../../lib/auth';
import { useQuery } from '../../lib/useQuery';
import type { Delivery, NotificationSettings } from '../../lib/types';
import { DELIVERY_TONE } from '../../lib/status';
import { Button, Card, EmptyState, ErrorState, Field, IconButton, InlineError, Input, Notice, Pill, Skeleton, SkeletonRows, Toggle } from '../../components/ui';
import { ResponsiveTable, type Column } from '../../components/ResponsiveTable';
import { useToast } from '../../components/Toast';
import { SubPage } from './Settings';

const TRANSPORT: Record<string, string> = { smtp: 'SMTP server', resend: 'Resend', log: 'Server log only (emails are not actually sent)', disabled: 'Disabled — no emails are sent' };

export function NotificationsSettings() {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('notifications.manage');
  const q = useQuery((s) => api.get<{ settings: NotificationSettings | null; transport: string }>('/api/notifications/settings', undefined, s), []);
  const log = useQuery((s) => api.get<{ deliveries: Delivery[] }>('/api/notifications/deliveries', { limit: 30 }, s).then((r) => r.deliveries), [], { enabled: manage });
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ id: string; status: string; error?: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (q.data?.settings) setS(q.data.settings);
  }, [q.data]);
  useEffect(() => () => window.clearTimeout(pollRef.current), []);

  const poll = (id: string, attempt = 0) => {
    pollRef.current = window.setTimeout(async () => {
      try {
        const r = await api.get<{ deliveries: Delivery[] }>('/api/notifications/deliveries', { id });
        const d = r.deliveries[0];
        if (d) setTest({ id, status: d.status, error: d.last_error });
        if (d && (d.status === 'queued' || d.status === 'sending') && attempt < 40) poll(id, attempt + 1);
        else {
          setTesting(false);
          log.reload();
        }
      } catch (x) {
        setTest({ id, status: 'unknown', error: errorMessage(x) });
        setTesting(false);
      }
    }, attempt < 5 ? 1500 : 3000);
  };

  if (q.error) return <SubPage title="Notifications"><Card><ErrorState message={q.error} onRetry={q.reload} /></Card></SubPage>;
  if (!s) return <SubPage title="Notifications"><Skeleton h={300} r={16} /></SubPage>;

  const bool = (k: keyof NotificationSettings, label: string, desc?: string) => (
    <Toggle checked={!!s[k]} onChange={(v) => setS({ ...s, [k]: v })} label={label} description={desc} disabled={!manage} />
  );
  const addEmail = () => {
    const e = newEmail.trim().toLowerCase();
    if (!e) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return setErr('That doesn’t look like an email address.');
    if (s.emails.includes(e)) return setNewEmail('');
    if (s.emails.length >= 10) return setErr('Up to 10 addresses.');
    setErr(null);
    setS({ ...s, emails: [...s.emails, e] });
    setNewEmail('');
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.put('/api/notifications/settings', s);
      toast.success('Notification settings saved');
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<{ id: string; status: string; transport: string }>('/api/notifications/test');
      setTest({ id: r.id, status: r.status });
      poll(r.id);
    } catch (x) {
      setTest({ id: '', status: 'failed', error: errorMessage(x) });
      setTesting(false);
    }
  };

  const cols: Column<Delivery>[] = [
    { key: 'when', header: 'Created', cell: (d) => <span className="nowrap small">{fmt.dateTime(d.created_at)}</span> },
    { key: 'subject', header: 'Subject', cell: (d) => <span className="small">{d.subject}</span> },
    { key: 'to', header: 'To', cell: (d) => <span className="small">{d.to_addresses.join(', ')}</span> },
    { key: 'status', header: 'Status', cell: (d) => <span className="stack-sm" style={{ gap: 2 }}><Pill tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{d.status}</Pill>{d.last_error && <span className="xs" style={{ color: 'var(--error-fg)' }}>{d.last_error}</span>}</span> },
    { key: 'attempts', header: 'Tries', className: 'num', cell: (d) => d.attempts },
    { key: 'act', header: '', cell: (d) => (d.status === 'failed' || d.status === 'suppressed' ? <Button size="sm" icon={RefreshCw} onClick={(e) => { e.stopPropagation(); void api.post(`/api/notifications/deliveries/${d.id}/retry`).then(() => { toast.success('Queued for retry'); log.reload(); }).catch(toast.error); }}>Retry</Button> : null) },
  ];

  return (
    <SubPage title="Notifications" lede="Email alerts for things that need attention, plus an optional daily summary.">
      <Notice tone={q.data?.transport === 'log' || q.data?.transport === 'disabled' ? 'warning' : undefined} icon={Mail}>
        Email delivery: <strong>{TRANSPORT[q.data?.transport ?? 'disabled'] ?? q.data?.transport}</strong>
      </Notice>
      {!manage && <Notice>Only the owner can change notification settings.</Notice>}
      <Card title="Recipients" hint="Up to 10 addresses">
        <div className="card-body stack">
          <div className="chips" aria-label="Recipient emails">
            {s.emails.length === 0 && <span className="muted small">No recipients — no emails will be sent.</span>}
            {s.emails.map((e) => (
              <span key={e} className="chip" style={{ cursor: 'default', paddingRight: manage ? 4 : 12 }}>
                {e}
                {manage && <IconButton icon={X} size="sm" label={`Remove ${e}`} onClick={() => setS({ ...s, emails: s.emails.filter((x) => x !== e) })} />}
              </span>
            ))}
          </div>
          {manage && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); addEmail(); }}>
              <label className="sr-only" htmlFor="ns-email">Add email address</label>
              <Input id="ns-email" type="email" inputMode="email" placeholder="name@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              <Button type="submit" icon={Plus}>Add</Button>
            </form>
          )}
        </div>
      </Card>
      <Card title="What to send">
        <div className="card-body">
          {bool('late_arrival', 'Late arrivals')}
          {bool('missing_checkout', 'Missing check-outs')}
          {bool('unknown_face', 'Unrecognised faces at the kiosk')}
          {bool('suspicious_events', 'Events needing review', 'Offline conflicts, clock problems, identity mismatches.')}
          {bool('device_offline', 'Kiosk offline')}
          {bool('sync_failure', 'Kiosk sync failures')}
          {bool('on_check_in', 'Every check-in', 'Can be a lot of email.')}
          {bool('on_check_out', 'Every check-out')}
          {bool('important_only', 'Important only', 'When on, routine check-in/out emails are only sent if something is unusual.')}
          {bool('include_staff_id', 'Include staff ID in emails')}
        </div>
      </Card>
      <Card title="Daily summary & quiet hours">
        <div className="card-body stack">
          {bool('daily_summary', 'Daily summary email', 'Who was late, absent, or missed a check-out.')}
          <div className="form-grid">
            <Field label="Send summary at" htmlFor="ns-time"><Input id="ns-time" type="time" value={s.daily_summary_time} onChange={(e) => setS({ ...s, daily_summary_time: e.target.value })} disabled={!manage || !s.daily_summary} /></Field>
            <div />
            <Field label="Quiet hours start" optional htmlFor="ns-qs" help="Non-urgent emails wait until quiet hours end."><Input id="ns-qs" type="time" value={s.quiet_hours_start ?? ''} onChange={(e) => setS({ ...s, quiet_hours_start: e.target.value || null })} disabled={!manage} /></Field>
            <Field label="Quiet hours end" optional htmlFor="ns-qe"><Input id="ns-qe" type="time" value={s.quiet_hours_end ?? ''} onChange={(e) => setS({ ...s, quiet_hours_end: e.target.value || null })} disabled={!manage} /></Field>
          </div>
        </div>
      </Card>
      <InlineError>{err}</InlineError>
      {manage && (
        <div className="form-actions">
          <Button variant="primary" loading={busy} onClick={() => void save()}>Save notification settings</Button>
        </div>
      )}
      {manage && (
        <Card title="Test email" hint="Sends to the saved recipients">
          <div className="card-body stack">
            <div className="row-wrap">
              <Button icon={Send} loading={testing} onClick={() => void sendTest()}>Send test email</Button>
              {test && (
                <span className="row small" role="status" aria-live="polite">
                  Status: <Pill tone={DELIVERY_TONE[test.status] ?? 'error'}>{test.status}</Pill>
                  {(test.status === 'queued' || test.status === 'sending') && <span className="subtle">checking…</span>}
                </span>
              )}
            </div>
            {test?.error && <InlineError>{test.error}</InlineError>}
            {test?.status === 'sent' && q.data?.transport === 'log' && <p className="subtle xs">“Sent” here means written to the server log — no real email leaves the server with the log transport.</p>}
          </div>
        </Card>
      )}
      {manage && (
        <Card title="Delivery log" actions={<IconButton icon={RefreshCw} label="Refresh delivery log" size="sm" onClick={log.reload} />}>
          {log.loading && !log.data ? <SkeletonRows rows={3} avatar={false} /> : log.error ? <ErrorState message={log.error} onRetry={log.reload} /> : !log.data?.length ? (
            <EmptyState icon={Mail} title="No emails yet" />
          ) : (
            <ResponsiveTable
              caption="Email deliveries"
              rows={log.data}
              columns={cols}
              rowKey={(d) => d.id}
              card={(d) => (
                <>
                  <div className="mcard-row"><span className="strong small truncate">{d.subject}</span><Pill tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{d.status}</Pill></div>
                  <div className="mcard-meta"><span>{fmt.dateTime(d.created_at)}</span><span>{d.to_addresses.join(', ')}</span><span>{d.attempts} tries</span></div>
                  {d.last_error && <span className="xs" style={{ color: 'var(--error-fg)' }}>{d.last_error}</span>}
                  {(d.status === 'failed' || d.status === 'suppressed') && <div><Button size="sm" icon={RefreshCw} onClick={() => void api.post(`/api/notifications/deliveries/${d.id}/retry`).then(() => { toast.success('Queued for retry'); log.reload(); }).catch(toast.error)}>Retry</Button></div>}
                </>
              )}
            />
          )}
        </Card>
      )}
    </SubPage>
  );
}
