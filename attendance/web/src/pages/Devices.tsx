import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Plus, RefreshCw, Tablet, PencilLine, Ban } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useNow, useQuery } from '../lib/useQuery';
import { useBranches } from '../lib/data';
import type { Device, PairingInfo } from '../lib/types';
import { fmtRelative } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, Field, IconButton, InlineError, PageHead, Select, SkeletonRows, StatusPill, TextField, Notice } from '../components/ui';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

function Countdown({ until }: { until: string }) {
  const now = useNow(1000);
  const ms = new Date(until).getTime() - now.getTime();
  if (ms <= 0) return <span style={{ color: 'var(--error-fg)', fontWeight: 600 }}>Expired — create a new code</span>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return <span className="num">Expires in {m}:{String(s).padStart(2, '0')}</span>;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function PairingPanel({ info, name }: { info: PairingInfo; name: string }) {
  const toast = useToast();
  return (
    <div className="stack">
      <p className="muted small">Pairing code for <strong>{name}</strong>. It’s shown only once.</p>
      <div className="pair-code" aria-label={`Pairing code ${info.pairing_code.split('').join(' ')}`}>{info.pairing_code}</div>
      <div className="row-between small">
        <Countdown until={info.expires_at} />
        <Button size="sm" icon={Copy} onClick={async () => (await copy(info.pairing_code)) ? toast.success('Code copied') : toast.error('Copy not available')}>Copy code</Button>
      </div>
      <Field label="Server address">
        <div className="copy-box"><span>{info.server_url}</span><IconButton size="sm" icon={Copy} label="Copy server address" onClick={async () => (await copy(info.server_url)) ? toast.success('Address copied') : toast.error('Copy not available')} /></div>
      </Field>
      <ol className="steps">
        <li>Install and open the Attendance Kiosk app on the Android tablet.</li>
        <li>Enter the server address above when asked.</li>
        <li>Type the pairing code exactly as shown (dashes optional).</li>
        <li>Mount the tablet at the entrance at face height, plugged into power, on Wi-Fi.</li>
        <li>Enroll staff faces from the kiosk’s <strong>Manager mode</strong>.</li>
      </ol>
    </div>
  );
}

export function DevicesPage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const toast = useToast();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const branches = useBranches();
  const q = useQuery((s) => api.get<{ offline_after_minutes: number; devices: Device[] }>('/api/devices', undefined, s), [], { tables: ['devices'] });
  const [addOpen, setAddOpen] = useState(params.get('add') === '1');
  const [name, setName] = useState('Front entrance');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ info: PairingInfo; name: string } | null>(null);
  const [rename, setRename] = useState<Device | null>(null);
  const [newName, setNewName] = useState('');
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [repair, setRepair] = useState<Device | null>(null);

  useEffect(() => {
    if (params.get('add') === '1') {
      const p = new URLSearchParams(params);
      p.delete('add');
      setParams(p, { replace: true });
    }
  }, [params, setParams]);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<PairingInfo>('/api/devices', { name: name.trim(), branch_id: branchId || null });
      setAddOpen(false);
      setPairing({ info: r, name: name.trim() });
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  const devices = q.data?.devices ?? [];
  return (
    <>
      <PageHead title="Kiosks" lede="Android tablets where staff check in and out." actions={can('devices.manage') && <Button variant="primary" icon={Plus} onClick={() => { setErr(null); setAddOpen(true); }}>Add kiosk</Button>} />
      <Card>
        {q.loading && !q.data ? <SkeletonRows rows={2} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !devices.length ? (
          <EmptyState icon={Tablet} title="No kiosks yet" action={can('devices.manage') ? <Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>Add your first kiosk</Button> : undefined}>Pair an Android tablet so staff can check in with their face.</EmptyState>
        ) : (
          <div className="list">
            {devices.map((d) => {
              const st = d.status === 'revoked' ? { label: 'Revoked', tone: 'neutral' as const } : d.status === 'pending' ? { label: 'Waiting to pair', tone: 'attention' as const } : d.online ? { label: 'Online', tone: 'success' as const } : { label: 'Offline', tone: 'error' as const };
              return (
                <div className="list-item rich" key={d.id}>
                  <span className="attention-icon tone-neutral"><Tablet aria-hidden /></span>
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <div className="row-wrap"><span className="strong">{d.name}</span><StatusPill info={st} /></div>
                    <span className="subtle xs">
                      {d.status === 'pending' ? (d.pairing_expires_at && new Date(d.pairing_expires_at) > now ? `Pairing code expires ${fmtRelative(d.pairing_expires_at, now)}` : 'Pairing code expired — create a new one') : `Last seen ${fmtRelative(d.last_seen_at, now)}${d.last_seen_at ? ` (${fmt.dateTime(d.last_seen_at)})` : ''}`}
                    </span>
                    <span className="subtle xs">
                      {[d.branch_name, d.device_model, d.app_version ? `App ${d.app_version}` : null, d.last_sync_at ? `Synced ${fmtRelative(d.last_sync_at, now)}` : null].filter(Boolean).join(' · ') || 'Not paired yet'}
                    </span>
                    {d.pending_queue_count > 0 && <span className="xs" style={{ color: 'var(--warning-fg)', fontWeight: 600 }}>{d.pending_queue_count} events waiting to sync</span>}
                    {d.last_error && <span className="xs" style={{ color: 'var(--error-fg)' }}>Last error: {d.last_error}</span>}
                  </div>
                  {can('devices.manage') && (
                    <div className="actions">
                      <IconButton icon={PencilLine} label={`Rename ${d.name}`} size="sm" onClick={() => { setRename(d); setNewName(d.name); }} />
                      <Button size="sm" icon={RefreshCw} onClick={() => setRepair(d)}>{d.status === 'active' ? 'Re-pair' : 'New code'}</Button>
                      {d.status !== 'revoked' && <Button size="sm" variant="danger-ghost" icon={Ban} onClick={() => setRevoke(d)}>Revoke</Button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {q.data && <p className="subtle xs" style={{ marginTop: 12 }}>A kiosk is shown offline when it hasn’t reported for {q.data.offline_after_minutes} minutes. Kiosks keep recording offline and sync when they reconnect.</p>}

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add a kiosk" footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>Create pairing code</Button></>}>
        <div className="stack">
          <TextField label="Kiosk name" value={name} onChange={(e) => setName(e.target.value)} help="Where it is, e.g. “Front entrance” or “Kitchen door”." data-autofocus />
          {(branches.data?.length ?? 0) > 1 && (
            <Field label="Branch" htmlFor="dev-branch">
              <Select id="dev-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">No branch</option>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
          <InlineError>{err}</InlineError>
        </div>
      </Dialog>

      <Dialog open={!!pairing} onClose={() => setPairing(null)} title="Pair your kiosk" footer={<Button variant="primary" onClick={() => setPairing(null)}>Done</Button>}>
        {pairing && <PairingPanel info={pairing.info} name={pairing.name} />}
      </Dialog>

      <Dialog open={!!rename} onClose={() => setRename(null)} title="Rename kiosk" footer={<><Button onClick={() => setRename(null)}>Cancel</Button><Button variant="primary" disabled={!newName.trim()} onClick={async () => { try { await api.patch(`/api/devices/${rename!.id}`, { name: newName.trim() }); toast.success('Kiosk renamed'); setRename(null); q.reload(); } catch (x) { toast.error(x); } }}>Save</Button></>}>
        <TextField label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} data-autofocus />
      </Dialog>

      <ConfirmDialog
        open={!!repair}
        onClose={() => setRepair(null)}
        title={`New pairing code for ${repair?.name}?`}
        confirmLabel="Create code"
        description={repair?.status === 'active' ? 'The tablet will be signed out immediately and must be paired again with the new code.' : 'Any previous code stops working.'}
        onConfirm={async () => {
          if (!repair) return;
          const r = await api.post<PairingInfo>(`/api/devices/${repair.id}/pairing-code`);
          setPairing({ info: r, name: repair.name });
          q.reload();
        }}
      />
      <ConfirmDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        danger
        title={`Revoke ${revoke?.name}?`}
        confirmLabel="Revoke kiosk"
        description="The tablet is signed out immediately and can no longer record attendance. Use this if a tablet is lost or replaced. You can re-pair it later with a new code."
        onConfirm={async () => {
          if (!revoke) return;
          await api.post(`/api/devices/${revoke.id}/revoke`);
          toast.success('Kiosk revoked');
          q.reload();
        }}
      >
        {revoke && revoke.pending_queue_count > 0 && <Notice tone="warning">This kiosk still has {revoke.pending_queue_count} unsynced events. They will be lost if you revoke now.</Notice>}
      </ConfirmDialog>
    </>
  );
}
