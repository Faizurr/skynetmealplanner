import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Activity, BarChart3, Bell, CalendarClock, ClipboardCheck, Clock, Home, LayoutGrid, Menu, Moon, ScanFace, Settings, Sun, SunMoon,
  Tablet, Users, WifiOff, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useRealtime } from '../lib/realtime';
import { useOnline, useQuery } from '../lib/useQuery';
import { api } from '../lib/api';
import type { Overview, Permission } from '../lib/types';
import { readThemePref, saveThemePref, type ThemePref } from '../lib/theme';
import { IconButton } from './ui';
import { RestaurantSwitcher } from './RestaurantSwitcher';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  count?: (o: Overview['metrics']) => number;
  section?: string;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: Home },
  { to: '/live', label: 'Live feed', icon: Activity },
  { to: '/attendance', label: 'Timesheets', icon: Clock },
  { to: '/staff', label: 'Staff', icon: Users, perm: 'employees.read' },
  { to: '/alerts', label: 'Alerts', icon: Bell, count: (m) => m.open_exceptions },
  { to: '/corrections', label: 'Corrections', icon: ClipboardCheck, count: (m) => m.pending_corrections, section: 'Review' },
  { to: '/enrollments', label: 'Face enrollments', icon: ScanFace, perm: 'biometrics.manage', count: (m) => m.pending_enrollments },
  { to: '/insights', label: 'Insights & reports', icon: BarChart3 },
  { to: '/shifts', label: 'Shifts', icon: CalendarClock, section: 'Setup' },
  { to: '/devices', label: 'Kiosks', icon: Tablet },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Today'],
  [/^\/live/, 'Live feed'],
  [/^\/attendance/, 'Timesheets'],
  [/^\/staff/, 'Staff'],
  [/^\/alerts/, 'Alerts'],
  [/^\/corrections/, 'Corrections'],
  [/^\/enrollments/, 'Face enrollments'],
  [/^\/insights/, 'Insights'],
  [/^\/shifts/, 'Shifts'],
  [/^\/devices/, 'Kiosks'],
  [/^\/settings/, 'Settings'],
  [/^\/more/, 'More'],
];

export function ConnectionIndicator() {
  const { state } = useRealtime();
  const label = state === 'live' ? 'Live' : state === 'off' ? 'Offline' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className={`conn ${state}`} role="status" aria-live="polite" title={state === 'live' ? 'Receiving updates in real time' : 'Trying to reconnect for live updates'}>
      <span className="conn-dot" aria-hidden />
      {label}
    </span>
  );
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(() => readThemePref());
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : SunMoon;
  const names: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  return (
    <IconButton
      icon={Icon}
      size="sm"
      label={`Theme: ${names[pref]}. Switch to ${names[next[pref]]}`}
      onClick={() => {
        const n = next[pref];
        setPref(n);
        saveThemePref(n);
      }}
    />
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const loc = useLocation();
  const online = useOnline();
  const [railOpen, setRailOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const counts = useQuery((s) => api.get<Overview>('/api/overview', undefined, s).then((o) => o.metrics), [], {
    tables: ['attendance_exceptions', 'attendance_events', 'face_enrollments', 'attendance_sessions'],
  });
  const m = counts.data;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    setRailOpen(false);
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  const title = TITLES.find(([re]) => re.test(loc.pathname))?.[1] ?? '';
  const items = NAV.filter((n) => !n.perm || can(n.perm));
  const alertsBadge = m ? m.open_exceptions : 0;
  const moreActive = !['/', '/live', '/staff', '/alerts'].some((p) => (p === '/' ? loc.pathname === '/' : loc.pathname.startsWith(p)));

  return (
    <div className={`shell ${railOpen ? 'rail-open' : ''}`}>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <div className="brand-text grow">
            <div className="brand-name truncate">{me?.restaurant.name}</div>
            <div className="brand-sub">Attendance</div>
          </div>
        </div>
        <IconButton icon={Menu} label={railOpen ? 'Collapse navigation' : 'Expand navigation'} className="rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)} />
        <nav className="nav" aria-label="Main navigation">
          {items.map((n) => {
            const c = m && n.count ? n.count(m) : 0;
            return (
              <div key={n.to}>
                {n.section && <div className="nav-section">{n.section}</div>}
                <NavLink to={n.to} end={n.to === '/'} className="nav-link" title={n.label}>
                  <n.icon aria-hidden />
                  <span className="nav-label">{n.label}</span>
                  {c > 0 && <span className="nav-count" aria-label={`${c} pending`}>{c}</span>}
                  {c > 0 && <span className="rail-dot" aria-hidden />}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="hide-rail"><RestaurantSwitcher compact /></div>
        </div>
      </aside>

      <div className="main">
        <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
          <img className="brand-mark only-mobile" src="/favicon.svg" alt="" width={26} height={26} style={{ width: 26, height: 26, borderRadius: 7 }} />
          <div className="topbar-title truncate">
            <span className="hide-mobile">{title}</span>
            <span className="only-mobile">{title === 'Today' ? me?.restaurant.name : title}</span>
          </div>
          <div className="topbar-actions">
            <ConnectionIndicator />
            <ThemeToggle />
          </div>
        </header>
        {!online && (
          <div className="banner offline" role="status">
            <WifiOff aria-hidden />
            You’re offline. The dashboard needs a connection to show live attendance.
          </div>
        )}
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end className="tab">
          <Home aria-hidden />
          Today
        </NavLink>
        <NavLink to="/live" className="tab">
          <Activity aria-hidden />
          Live
        </NavLink>
        {can('employees.read') && (
          <NavLink to="/staff" className="tab">
            <Users aria-hidden />
            Staff
          </NavLink>
        )}
        <NavLink to="/alerts" className="tab">
          <Bell aria-hidden />
          Alerts
          {alertsBadge > 0 && <span className="tab-badge" aria-label={`${alertsBadge} open alerts`}>{alertsBadge > 99 ? '99+' : alertsBadge}</span>}
        </NavLink>
        <Link to="/more" className="tab" aria-current={moreActive ? 'page' : undefined}>
          <LayoutGrid aria-hidden />
          More
        </Link>
      </nav>
    </div>
  );
}
