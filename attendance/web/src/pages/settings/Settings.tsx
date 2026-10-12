import { useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import {
  Bell, Building2, ChevronLeft, ChevronRight, Download, History, LogOut, ScanFace, Shield, Smartphone, Store, UserCog, Users, Plus, PencilLine, type LucideIcon,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useQuery } from '../../lib/useQuery';
import type { Branch, Permission, RestaurantSettings } from '../../lib/types';
import { canInstall, isIos, isStandalone, onInstallAvailability, promptInstall } from '../../lib/pwa';
import { Button, Card, ErrorState, Field, InlineError, Notice, PageHead, Select, Skeleton, TextArea, TextField, Toggle, Pill, EmptyState } from '../../components/ui';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { timezoneOptions, ChangePasswordForm } from '../Auth';
import { RestaurantSwitcher } from '../../components/RestaurantSwitcher';
import { ThemeToggle } from '../../components/Layout';
import { NotificationsSettings } from './Notifications';
import { TeamSettings } from './Team';
import { AuditLog } from './Audit';

interface Section {
  to: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  perm?: Permission;
}

const SECTIONS: Section[] = [
  { to: 'restaurant', label: 'Restaurant', desc: 'Name and time zone', icon: Store },
  { to: 'kiosk', label: 'Kiosk & recognition', desc: 'Face matching, PIN fallback, offline rules, hours rules', icon: ScanFace },
  { to: 'branches', label: 'Branches', desc: 'Locations', icon: Building2 },
  { to: 'notifications', label: 'Notifications', desc: 'Email alerts and daily summary', icon: Bell },
  { to: 'team', label: 'Team', desc: 'Who can access the dashboard', icon: Users, perm: 'team.manage' },
  { to: 'audit', label: 'Audit log', desc: 'Every change, who made it and when', icon: History, perm: 'audit.read' },
  { to: 'privacy', label: 'Privacy & security', desc: 'What biometric data is stored and why', icon: Shield },
  { to: 'account', label: 'Your account', desc: 'Password, sign out', icon: UserCog },
  { to: 'install', label: 'Install the app', desc: 'Add to your home screen', icon: Smartphone },
];

export function SubPage({ title, lede, children, actions }: { title: string; lede?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <Link to="/settings" className="back-link"><ChevronLeft aria-hidden />Settings</Link>
      <PageHead title={title} lede={lede} actions={actions} />
      <div className="stack">{children}</div>
    </>
  );
}

function SettingsIndex() {
  const { can, me } = useAuth();
  return (
    <>
      <PageHead title="Settings" lede={me?.restaurant.name} />
      <Card>
        <nav className="list" aria-label="Settings sections">
          {SECTIONS.filter((s) => !s.perm || can(s.perm)).map((s) => (
            <Link key={s.to} to={`/settings/${s.to}`} className="list-item">
              <span className="attention-icon tone-neutral"><s.icon aria-hidden /></span>
              <span className="grow">
                <span className="strong small" style={{ display: 'block' }}>{s.label}</span>
                <span className="subtle xs" style={{ display: 'block' }}>{s.desc}</span>
              </span>
              <ChevronRight className="chev" aria-hidden />
            </Link>
          ))}
        </nav>
      </Card>
    </>
  );
}

function useSettings() {
  return useQuery((s) => api.get<{ restaurant: { id: string; name: string; timezone: string }; settings: RestaurantSettings }>('/api/settings', undefined, s), []);
}

function RestaurantSettingsPage() {
  const { can, refresh } = useAuth();
  const toast = useToast();
  const q = useSettings();
  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) {
      setName(q.data.restaurant.name);
      setTz(q.data.restaurant.timezone);
    }
  }, [q.data]);
  const readOnly = !can('settings.manage');
  return (
    <SubPage title="Restaurant" lede="All times in the dashboard, emails and reports use this time zone.">
      <Card pad>
        {q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data ? <Skeleton h={120} /> : (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await api.put('/api/settings', { name: name.trim(), timezone: tz });
              toast.success('Restaurant updated');
              await refresh();
            } catch (x) {
              setErr(errorMessage(x));
            } finally {
              setBusy(false);
            }
          }}>
            <TextField label="Restaurant name" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
            <Field label="Time zone" htmlFor="rs-tz" help="Changing this affects how future and past times are displayed and how days are counted.">
              <Select id="rs-tz" value={tz} onChange={(e) => setTz(e.target.value)} disabled={readOnly}>
                {timezoneOptions(tz).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </Select>
            </Field>
            <InlineError>{err}</InlineError>
            {!readOnly && <div className="form-actions"><Button type="submit" variant="primary" loading={busy}>Save</Button></div>}
          </form>
        )}
      </Card>
    </SubPage>
  );
}

type NumKey = { [K in keyof RestaurantSettings]: RestaurantSettings[K] extends number ? K : never }[keyof RestaurantSettings];
type BoolKey = { [K in keyof RestaurantSettings]: RestaurantSettings[K] extends boolean ? K : never }[keyof RestaurantSettings];

function KioskSettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useSettings();
  const [s, setS] = useState<RestaurantSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data.settings);
  }, [q.data]);
  const ro = !can('settings.manage');
  if (q.error) return <SubPage title="Kiosk & recognition"><Card><ErrorState message={q.error} onRetry={q.reload} /></Card></SubPage>;
  if (!s) return <SubPage title="Kiosk & recognition"><Skeleton h={300} r={16} /></SubPage>;

  const num = (k: NumKey, label: string, help: ReactNode, opts: { step?: number; min?: number; max?: number; warn?: ReactNode } = {}) => (
    <TextField
      label={label}
      type="number"
      inputMode="decimal"
      step={opts.step ?? 1}
      min={opts.min}
      max={opts.max}
      value={Number.isFinite(s[k]) ? String(s[k]) : ''}
      onChange={(e) => setS({ ...s, [k]: e.target.value === '' ? NaN : Number(e.target.value) })}
      help={help}
      disabled={ro}
    />
  );
  const bool = (k: BoolKey, label: string, desc: ReactNode) => <Toggle checked={s[k]} onChange={(v) => setS({ ...s, [k]: v })} label={label} description={desc} disabled={ro} />;
  const lowThreshold = s.match_threshold < 0.45;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.put('/api/settings', { settings: s });
      toast.success('Settings saved');
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SubPage title="Kiosk & recognition" lede="How the kiosk identifies staff and how hours are calculated." actions={!ro && <Button variant="primary" loading={busy} onClick={() => void save()}>Save changes</Button>}>
      <Card title="Face recognition">
        <div className="card-body stack">
          <div className="form-grid">
            <div className="stack-sm">
              {num('match_threshold', 'Match threshold', 'How similar a face must be to an enrolled face (0.30–0.90). Higher = stricter, fewer wrong matches but more “not recognised”. Default 0.50.', { step: 0.01, min: 0.3, max: 0.9 })}
              {lowThreshold && <Notice tone="warning">Below 0.45 the risk of recording attendance for the <strong>wrong person</strong> rises noticeably. Only lower this if you’ve tested it at your site.</Notice>}
            </div>
            {num('match_margin', 'Match margin', 'The best match must beat the next most similar employee by at least this much (0–0.50). Prevents mix-ups between look-alikes. Default 0.06.', { step: 0.01, min: 0, max: 0.5 })}
          </div>
          {bool('liveness_required', 'Require liveness check', 'Blocks photos or screens held up to the camera. Strongly recommended.')}
          {bool('pin_fallback_enabled', 'Allow PIN fallback', 'Staff with a PIN can check in with staff ID + PIN when their face isn’t recognised. PIN events are labelled.')}
        </div>
      </Card>
      <Card title="Kiosk screen">
        <div className="card-body stack">
          <div className="form-grid">
            {num('success_return_seconds', 'Success screen (seconds)', 'How long the confirmation stays on screen before returning to the start (2–30).', { min: 2, max: 30 })}
          </div>
          {bool('sound_enabled', 'Sounds', 'Play a confirmation sound on check-in and check-out.')}
          <Field label="Instructions for staff" htmlFor="ks-instr" help="Shown on the kiosk home screen (max 200 characters).">
            <TextArea id="ks-instr" maxLength={200} value={s.employee_instructions} onChange={(e) => setS({ ...s, employee_instructions: e.target.value })} disabled={ro} />
          </Field>
        </div>
      </Card>
      <Card title="Offline mode">
        <div className="card-body stack">
          {bool('offline_mode_enabled', 'Allow offline check-ins', 'If the internet drops, the kiosk keeps recording and uploads later. Offline events are labelled “Offline-synced”.')}
          <div className="form-grid">
            {num('max_offline_age_hours', 'Max offline age (hours)', 'Offline events older than this when they arrive are held for review (1–336).', { min: 1, max: 336 })}
            {num('max_clock_skew_minutes', 'Max clock difference (minutes)', 'If the kiosk clock is off by more than this, its events are flagged (1–120).', { min: 1, max: 120 })}
          </div>
        </div>
      </Card>
      <Card title="Hours rules">
        <div className="card-body stack">
          <p className="subtle xs">Defaults for staff without an assigned shift. Shifts have their own break and overtime rules.</p>
          <div className="form-grid">
            {num('default_unpaid_break_minutes', 'Default unpaid break (min)', 'Deducted from worked time.', { min: 0, max: 480 })}
            {num('default_break_applies_after_minutes', 'Break applies after (min)', 'Only deduct the break when the session is longer than this.', { min: 0, max: 1440 })}
            {num('default_overtime_after_minutes', 'Overtime after (min)', 'Worked minutes beyond this count as overtime.', { min: 0, max: 1440 })}
            {num('max_session_hours', 'Max session length (hours)', 'Sessions open longer than this are closed as “missing check-out” (4–36).', { min: 4, max: 36 })}
            {num('missing_checkout_grace_minutes', 'Missing check-out alert after (min)', 'Alert this long after the scheduled shift end (0–720).', { min: 0, max: 720 })}
            {num('min_minutes_between_in_and_out', 'Minimum minutes between in and out', 'Prevents accidental double taps (0–60).', { min: 0, max: 60 })}
            {num('early_check_in_window_minutes', 'Early check-in window (min)', 'How early before a shift a check-in still counts for that shift (0–720).', { min: 0, max: 720 })}
          </div>
          <div className="form-grid">
            <Field label="Report rounding" htmlFor="ks-round" help="Applied to the “worked rounded” column in the timesheet export only.">
              <Select id="ks-round" value={String(s.rounding_minutes)} onChange={(e) => setS({ ...s, rounding_minutes: Number(e.target.value) })} disabled={ro}>
                {[0, 1, 5, 6, 10, 15, 30].map((v) => <option key={v} value={v}>{v === 0 ? 'No rounding' : `${v} minutes`}</option>)}
              </Select>
            </Field>
            <Field label="Rounding mode" htmlFor="ks-rmode">
              <Select id="ks-rmode" value={s.rounding_mode} onChange={(e) => setS({ ...s, rounding_mode: e.target.value as RestaurantSettings['rounding_mode'] })} disabled={ro || s.rounding_minutes === 0}>
                <option value="nearest">Nearest</option>
                <option value="down">Down</option>
                <option value="up">Up</option>
              </Select>
            </Field>
          </div>
        </div>
      </Card>
      <InlineError>{err}</InlineError>
      {!ro && <div className="form-actions"><Button variant="primary" loading={busy} onClick={() => void save()}>Save changes</Button></div>}
    </SubPage>
  );
}

function BranchesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery((s) => api.get<{ branches: Branch[] }>('/api/branches', undefined, s).then((r) => r.branches), []);
  const [edit, setEdit] = useState<Branch | 'new' | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = (b: Branch | 'new') => {
    setEdit(b);
    setErr(null);
    setName(b === 'new' ? '' : b.name);
    setAddress(b === 'new' ? '' : b.address ?? '');
    setActive(b === 'new' ? true : b.active);
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (edit === 'new') await api.post('/api/branches', { name: name.trim(), address: address.trim() || null });
      else if (edit) await api.patch(`/api/branches/${edit.id}`, { name: name.trim(), address: address.trim() || null, active });
      toast.success('Branch saved');
      setEdit(null);
      q.reload();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const canEdit = can('settings.manage');
  return (
    <SubPage title="Branches" lede="If you run more than one location, filters for branch appear across the dashboard." actions={canEdit && <Button variant="primary" icon={Plus} onClick={() => open('new')}>Add branch</Button>}>
      <Card>
        {q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data ? <div className="card-body"><Skeleton h={60} /></div> : !q.data.length ? <EmptyState title="No branches" /> : (
          <div className="list">
            {q.data.map((b) => (
              <div className="list-item" key={b.id}>
                <span className="attention-icon tone-neutral"><Building2 aria-hidden /></span>
                <span className="grow">
                  <span className="strong small" style={{ display: 'block' }}>{b.name} {!b.active && <Pill tone="neutral">Inactive</Pill>}</span>
                  <span className="subtle xs" style={{ display: 'block' }}>{[b.address, `${b.employee_count} staff`, `${b.device_count} kiosks`].filter(Boolean).join(' · ')}</span>
                </span>
                {canEdit && <Button size="sm" icon={PencilLine} onClick={() => open(b)}>Edit</Button>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add branch' : 'Edit branch'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>Save</Button></>}>
        <div className="stack">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          <TextField label="Address" optional value={address} onChange={(e) => setAddress(e.target.value)} />
          {edit !== 'new' && <Toggle checked={active} onChange={setActive} label="Active" description="Inactive branches are hidden from filters." />}
          <InlineError>{err}</InlineError>
        </div>
      </Dialog>
    </SubPage>
  );
}

function PrivacyPage() {
  return (
    <SubPage title="Privacy & security" lede="Plain-language summary of what this system stores about your staff.">
      <Card pad>
        <div className="prose">
          <h3>What biometric data is stored</h3>
          <ul>
            <li><strong>Face templates, not face photos.</strong> When a face is enrolled, the kiosk converts it into a list of 128 numbers (a “template”). Templates are encrypted (AES-256-GCM) before they’re stored. A template can’t be turned back into a picture.</li>
            <li><strong>Optional reference photo.</strong> If the manager chose to save one during enrollment (with consent), a single small photo is kept so you can confirm identity. It’s only visible to owners and managers.</li>
            <li><strong>No video and no images of check-ins.</strong> The kiosk compares faces on the device and sends only the numeric template for verification. Unrecognised faces raise an alert without any image.</li>
          </ul>
          <h3>Consent</h3>
          <p>Enrollment on the kiosk requires recording how the employee consented (written form, digital acknowledgement, or verbal with a witness). New enrollments must be confirmed by an owner or manager before use.</p>
          <h3>Retention</h3>
          <ul>
            <li>Biometric data is deleted automatically when you <strong>deactivate</strong> an employee (offboarding).</li>
            <li>You can delete an employee’s biometric data at any time from their profile. Attendance records are kept for payroll and legal record-keeping.</li>
          </ul>
          <h3>Employee rights</h3>
          <p>Employees may ask what data you hold about them, ask for corrections, or withdraw consent for face recognition (they can then use a PIN or manual check-in).</p>
          <ul>
            <li><strong>Access request:</strong> open the employee’s profile → <em>Export personal data (JSON)</em>.</li>
            <li><strong>Withdraw consent / erase biometrics:</strong> open the profile → <em>Delete biometric data</em>.</li>
            <li><strong>Correct records:</strong> use <Link to="/attendance">Timesheets</Link> → Adjust times. Original records are kept, and every change is in the <Link to="/settings/audit">audit log</Link>.</li>
          </ul>
          <h3>Security</h3>
          <ul>
            <li>Dashboard sessions use secure, HTTP-only cookies; kiosks use their own revocable device tokens.</li>
            <li>Each restaurant’s data is isolated at the database level.</li>
            <li>Every sensitive action (corrections, reviews, deletions, exports) is recorded in the audit log.</li>
          </ul>
        </div>
      </Card>
      <p className="subtle xs">This summary is not legal advice. Check your local data-protection rules (for example Malaysia’s PDPA) for your obligations.</p>
    </SubPage>
  );
}

function AccountPage() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  return (
    <SubPage title="Your account" lede={me ? `${me.user.full_name} · ${me.user.email}` : undefined}>
      <RestaurantSwitcher />
      <Card title="Appearance">
        <div className="card-body row-between">
          <span className="small muted">Light, dark, or follow your device.</span>
          <ThemeToggle />
        </div>
      </Card>
      <Card title="Change password">
        <div className="card-body"><ChangePasswordForm onDone={() => toast.success('Password changed. Other devices were signed out.')} /></div>
      </Card>
      <Card pad>
        <div className="row-between">
          <span className="small muted">Sign out on this device.</span>
          <Button icon={LogOut} onClick={() => void signOut()}>Sign out</Button>
        </div>
      </Card>
    </SubPage>
  );
}

function InstallPage() {
  const [available, setAvailable] = useState(canInstall());
  useEffect(() => onInstallAvailability(() => setAvailable(canInstall())), []);
  const standalone = isStandalone();
  return (
    <SubPage title="Install the app" lede="Get one-tap access from your home screen. It opens full-screen like a regular app.">
      {standalone && <Notice tone="info">You’re using the installed app.</Notice>}
      {available && (
        <Card pad>
          <div className="row-between">
            <span className="small">This browser can install the dashboard directly.</span>
            <Button variant="primary" icon={Download} onClick={() => void promptInstall()}>Install</Button>
          </div>
        </Card>
      )}
      <div className="grid grid-2">
        <Card title={<>iPhone & iPad {isIos() && <Pill tone="accent" dot={false}>Your device</Pill>}</>}>
          <div className="card-body">
            <ol className="steps">
              <li>Open this page in <strong>Safari</strong>.</li>
              <li>Tap the <strong>Share</strong> button (square with an arrow).</li>
              <li>Scroll and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong>. Open “Attendance” from your home screen.</li>
            </ol>
          </div>
        </Card>
        <Card title="Android">
          <div className="card-body">
            <ol className="steps">
              <li>Open this page in <strong>Chrome</strong>.</li>
              <li>Tap <strong>Install</strong> above, or the <strong>⋮</strong> menu → <strong>Install app</strong>.</li>
              <li>Confirm. The app appears in your app drawer.</li>
            </ol>
          </div>
        </Card>
      </div>
      <p className="subtle xs">The app needs an internet connection to show attendance. It never stores attendance data on your phone.</p>
    </SubPage>
  );
}

export function SettingsRoutes() {
  return (
    <Routes>
      <Route index element={<SettingsIndex />} />
      <Route path="restaurant" element={<RestaurantSettingsPage />} />
      <Route path="kiosk" element={<KioskSettingsPage />} />
      <Route path="branches" element={<BranchesPage />} />
      <Route path="notifications" element={<NotificationsSettings />} />
      <Route path="team" element={<TeamSettings />} />
      <Route path="audit" element={<AuditLog />} />
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="install" element={<InstallPage />} />
      <Route path="*" element={<SettingsIndex />} />
    </Routes>
  );
}
