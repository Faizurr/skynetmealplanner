import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AuthProvider, useAuth } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import { ToastProvider, useToast } from './components/Toast';
import { Shell } from './components/Layout';
import { Button, ErrorState, Skeleton } from './components/ui';
import { LoginPage, SignupPage, ChangePasswordPage } from './pages/Auth';
import { TodayPage } from './pages/Today';
import { LivePage } from './pages/Live';

const AttendancePage = lazy(() => import('./pages/Attendance').then((m) => ({ default: m.AttendancePage })));
const StaffPage = lazy(() => import('./pages/Staff').then((m) => ({ default: m.StaffPage })));
const EmployeePage = lazy(() => import('./pages/EmployeeDetail').then((m) => ({ default: m.EmployeePage })));
const EnrollmentsPage = lazy(() => import('./pages/Enrollments').then((m) => ({ default: m.EnrollmentsPage })));
const AlertsPage = lazy(() => import('./pages/Alerts').then((m) => ({ default: m.AlertsPage })));
const CorrectionsPage = lazy(() => import('./pages/Corrections').then((m) => ({ default: m.CorrectionsPage })));
const InsightsPage = lazy(() => import('./pages/Insights').then((m) => ({ default: m.InsightsPage })));
const ShiftsPage = lazy(() => import('./pages/Shifts').then((m) => ({ default: m.ShiftsPage })));
const DevicesPage = lazy(() => import('./pages/Devices').then((m) => ({ default: m.DevicesPage })));
const SettingsRoutes = lazy(() => import('./pages/settings/Settings').then((m) => ({ default: m.SettingsRoutes })));
const PayPage = lazy(() => import('./pages/Pay').then((m) => ({ default: m.PayPage })));
const SalariesPage = lazy(() => import('./pages/Salaries').then((m) => ({ default: m.SalariesPage })));
const LeaderboardPage = lazy(() => import('./pages/Leaderboard').then((m) => ({ default: m.LeaderboardPage })));
const MorePage = lazy(() => import('./pages/More').then((m) => ({ default: m.MorePage })));

function UpdatePrompt() {
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  useEffect(() => {
    if (!needRefresh) return undefined;
    const id = toast.show({ kind: 'info', message: 'New version available', sticky: true, action: { label: 'Reload', onClick: () => void updateServiceWorker(true) } });
    return () => toast.dismiss(id);
  }, [needRefresh, toast, updateServiceWorker]);
  return null;
}

function PageFallback() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <Skeleton w={220} h={28} />
      <Skeleton h={120} r={16} />
      <Skeleton h={240} r={16} />
    </div>
  );
}

function Splash() {
  return (
    <div className="auth" aria-busy="true" aria-label="Loading">
      <div className="stack" style={{ alignItems: 'center' }}>
        <img src="/favicon.svg" alt="" width={44} height={44} style={{ borderRadius: 11 }} />
        <span className="spinner" style={{ color: 'var(--text-3)' }} />
      </div>
    </div>
  );
}

function Gate() {
  const { me, loading, error, refresh } = useAuth();
  if (loading) return <Splash />;
  if (!me && error) {
    return (
      <div className="auth">
        <div className="auth-card card card-pad">
          <ErrorState message={error} onRetry={() => void refresh()} />
        </div>
      </div>
    );
  }
  if (!me) {
    return (
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (me.user.must_change_password) return <ChangePasswordPage forced />;
  return (
    <RealtimeProvider enabled>
      <Shell>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/attendance" element={<AttendancePage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/staff/:id" element={<EmployeePage />} />
            <Route path="/enrollments" element={<EnrollmentsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/corrections" element={<CorrectionsPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/shifts" element={<ShiftsPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/settings/*" element={<SettingsRoutes />} />
            <Route path="/pay" element={<PayPage />} />
            <Route path="/salaries" element={<SalariesPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/more" element={<MorePage />} />
            <Route path="/signup" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Shell>
    </RealtimeProvider>
  );
}

function NotFound() {
  return (
    <div className="card card-pad center stack">
      <h1>Page not found</h1>
      <p className="muted">That link doesn’t match anything in the dashboard.</p>
      <div><Button onClick={() => (window.location.hash = '#/')}>Go to Today</Button></div>
    </div>
  );
}

export function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <AuthProvider>
          <UpdatePrompt />
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </HashRouter>
  );
}
