import { useState } from 'react';
import { Copy, UserPlus, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth, useFmt } from '../../lib/auth';
import { useQuery } from '../../lib/useQuery';
import type { Role, TeamMember } from '../../lib/types';
import { ROLE_LABELS } from '../../lib/status';
import { Button, Card, EmptyState, ErrorState, Field, InlineError, Notice, Person, Pill, Select, SkeletonRows, TextField } from '../../components/ui';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { SubPage } from './Settings';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including settings, notifications and team.',
  manager: 'Day-to-day: staff, shifts, kiosks, reviews and corrections.',
  attendance_admin: 'View attendance, request corrections and export reports.',
};

export function TeamSettings() {
  const fmt = useFmt();
  const { me } = useAuth();
  const toast = useToast();
  const q = useQuery((s) => api.get<{ members: TeamMember[] }>('/api/team', undefined, s).then((r) => r.members), []);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('manager');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ email: string; password: string | null } | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const invite = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ user_id: string; temporary_password: string | null }>('/api/team', { email: email.trim(), full_name: name.trim(), role });
      setInviteOpen(false);
      setTemp({ email: email.trim(), password: r.temporary_password });
      setEmail('');
      setName('');
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SubPage title="Team" lede="People who can sign in to this dashboard." actions={<Button variant="primary" icon={UserPlus} onClick={() => { setErr(null); setInviteOpen(true); }}>Add person</Button>}>
      <Card>
        {q.loading && !q.data ? <SkeletonRows rows={3} /> : q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data?.length ? <EmptyState icon={Users} title="No team members" /> : (
          <div className="list">
            {q.data.map((m) => (
              <div className="list-item rich no-icon" key={m.id}>
                <div style={{ minWidth: 0 }}>
                  <Person name={m.full_name} sub={`${m.email} · ${m.last_login_at ? `last signed in ${fmt.date(m.last_login_at)}` : 'never signed in'}`} />
                </div>
                <div className="actions" style={{ alignItems: 'center' }}>
                {m.id === me?.user.id && <Pill tone="accent" dot={false}>You</Pill>}
                <label className="sr-only" htmlFor={`role-${m.id}`}>Role for {m.full_name}</label>
                <Select id={`role-${m.id}`} style={{ width: 'auto' }} value={m.role} onChange={async (e) => {
                  try {
                    await api.patch(`/api/team/${m.id}`, { role: e.target.value });
                    toast.success('Role updated');
                    q.reload();
                  } catch (x) {
                    toast.error(x);
                  }
                }}>
                  {(['owner', 'manager', 'attendance_admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </Select>
                <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(m)}>Remove</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} title="Add a team member" footer={<><Button onClick={() => setInviteOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!email.trim() || !name.trim()} onClick={() => void invite()}>Add</Button></>}>
        <div className="stack">
          <TextField label="Full name" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          <TextField label="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Role" htmlFor="tm-role" help={ROLE_HELP[role]}>
            <Select id="tm-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(['manager', 'attendance_admin', 'owner'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>
          </Field>
          <InlineError>{err}</InlineError>
        </div>
      </Dialog>

      <Dialog open={!!temp} onClose={() => setTemp(null)} title="Person added" footer={<Button variant="primary" onClick={() => setTemp(null)}>I’ve saved it</Button>}>
        {temp && (temp.password ? (
          <div className="stack">
            <p className="small muted">Share this temporary password with <strong>{temp.email}</strong> privately. It’s shown <strong>only once</strong>. They’ll be asked to choose a new password when they first sign in.</p>
            <div className="copy-box">
              <span>{temp.password}</span>
              <Button size="sm" icon={Copy} onClick={async () => { try { await navigator.clipboard.writeText(temp.password!); toast.success('Copied'); } catch { toast.error('Copy not available — select the text instead'); } }}>Copy</Button>
            </div>
          </div>
        ) : (
          <Notice>{temp.email} already has an account. They can sign in with their existing password and switch to this restaurant.</Notice>
        ))}
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        danger
        title={`Remove ${removing?.full_name}?`}
        confirmLabel="Remove"
        description="They lose access to this restaurant immediately and are signed out. Their past actions stay in the audit log."
        onConfirm={async () => {
          if (!removing) return;
          await api.del(`/api/team/${removing.id}`);
          toast.success('Removed from team');
          q.reload();
        }}
      />
    </SubPage>
  );
}
