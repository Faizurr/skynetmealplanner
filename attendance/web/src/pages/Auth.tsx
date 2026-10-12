import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, InlineError, Select, TextField, Field } from '../components/ui';
import { ThemeToggle } from '../components/Layout';

function AuthFrame({ title, lede, children, foot }: { title: string; lede?: string; children: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row-between">
          <div className="auth-brand">
            <img src="/favicon.svg" alt="" />
            <span className="strong">Attendance</span>
          </div>
          <div style={{ marginBottom: 24 }}><ThemeToggle /></div>
        </div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
        <div className="card card-pad">{children}</div>
        {foot && <div className="auth-foot">{foot}</div>}
      </div>
    </div>
  );
}

function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const i of e.issues) out[i.path.split('.')[0]] = i.message;
  return out;
}

export function LoginPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/auth/login', { email, password });
      await refresh();
    } catch (x) {
      setErr(errorMessage(x));
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Sign in" lede="See who’s working, who’s late, and what needs your attention." foot={<>New restaurant? <Link to="/signup">Create an account</Link></>}>
      <form className="stack" onSubmit={submit} noValidate>
        <TextField label="Email" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <InlineError>{err}</InlineError>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>Sign in</Button>
      </form>
    </AuthFrame>
  );
}

const TIMEZONES = ['Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Manila', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Dubai', 'Australia/Sydney', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];

export function timezoneOptions(current?: string): string[] {
  let all: string[] = TIMEZONES;
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (sv) all = sv('timeZone');
  } catch {
    /* older browsers */
  }
  if (current && !all.includes(current)) all = [current, ...all];
  return all;
}

export function SignupPage() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ restaurant_name: '', branch_name: 'Main', timezone: 'Asia/Kuala_Lumpur', full_name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setFe({});
    try {
      await api.post('/api/auth/signup', f);
      await refresh();
      window.location.hash = '#/';
    } catch (x) {
      setFe(fieldErrors(x));
      setErr(errorMessage(x));
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Create your restaurant" lede="Set up attendance in a few minutes. You can add staff and pair a kiosk next." foot={<>Already have an account? <Link to="/">Sign in</Link></>}>
      <form className="stack" onSubmit={submit} noValidate>
        <TextField label="Restaurant name" required value={f.restaurant_name} onChange={set('restaurant_name')} error={fe.restaurant_name} autoComplete="organization" />
        <div className="form-grid">
          <TextField label="First branch" value={f.branch_name} onChange={set('branch_name')} error={fe.branch_name} help="You can add more later." />
          <Field label="Time zone" htmlFor="su-tz" error={fe.timezone}>
            <Select id="su-tz" value={f.timezone} onChange={set('timezone')}>
              {timezoneOptions(f.timezone).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
        </div>
        <TextField label="Your name" required value={f.full_name} onChange={set('full_name')} error={fe.full_name} autoComplete="name" />
        <TextField label="Email" type="email" required value={f.email} onChange={set('email')} error={fe.email} autoComplete="email" inputMode="email" />
        <TextField label="Password" type="password" required value={f.password} onChange={set('password')} error={fe.password} autoComplete="new-password" help="At least 10 characters." minLength={10} />
        <InlineError>{Object.keys(fe).length ? null : err}</InlineError>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>Create account</Button>
      </form>
    </AuthFrame>
  );
}

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setErr('The new passwords don’t match.');
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/auth/change-password', { current_password: cur, new_password: next });
      setCur('');
      setNext('');
      setConfirm('');
      onDone?.();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <TextField label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
      <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} help="At least 10 characters. Other devices will be signed out." required />
      <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'Passwords don’t match' : null} required />
      <InlineError>{err}</InlineError>
      <div className="form-actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!cur || next.length < 10 || mismatch}>Change password</Button>
      </div>
    </form>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { refresh, signOut } = useAuth();
  return (
    <AuthFrame
      title={forced ? 'Choose a new password' : 'Change password'}
      lede={forced ? 'You signed in with a temporary password. Set your own password to continue.' : undefined}
      foot={<button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>}
    >
      <ChangePasswordForm onDone={() => void refresh()} />
    </AuthFrame>
  );
}
