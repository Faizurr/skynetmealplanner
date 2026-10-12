import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, UserPlus, Users, KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useFmt } from '../lib/auth';
import { useQuery, useDebounced } from '../lib/useQuery';
import type { Employee } from '../lib/types';
import { EMPLOYEE_STATUS, enrollmentInfo } from '../lib/status';
import { Button, Card, EmptyState, ErrorState, Input, PageHead, Person, SegmentedControl, SkeletonRows, StatusPill, Pill, Notice } from '../components/ui';
import { ResponsiveTable, type Column } from '../components/ResponsiveTable';
import { EmployeeForm } from '../components/EmployeeForm';

type StatusFilter = 'active' | 'suspended' | 'deactivated' | 'all';

export function StaffPage() {
  const fmt = useFmt();
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'active') as StatusFilter;
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const formOpen = params.get('new') === '1';
  const list = useQuery((s) => api.get<{ employees: Employee[] }>('/api/employees', { status, q: q || undefined }, s).then((r) => r.employees), [status, q], {
    tables: ['employees', 'face_enrollments', 'attendance_sessions'],
  });
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const notEnrolled = useMemo(() => (list.data ?? []).filter((e) => e.status === 'active' && !e.enrollment).length, [list.data]);

  const columns: Column<Employee>[] = [
    { key: 'name', header: 'Name', cell: (e) => <Person name={e.full_name} sub={`${e.staff_id}${e.job_title ? ` · ${e.job_title}` : ''}`} employeeId={e.id} hasPhoto={e.has_photo} /> },
    { key: 'now', header: 'Now', cell: (e) => (e.open_session ? <Pill tone="success">In since {fmt.time(e.open_session.check_in_at)}</Pill> : <span className="subtle">—</span>) },
    { key: 'shifts', header: 'Shifts', cell: (e) => (e.shifts.length ? <span className="small">{e.shifts.map((s) => s.name).join(', ')}</span> : <span className="subtle small">None</span>) },
    { key: 'branch', header: 'Branch', cell: (e) => <span className="small">{e.branch_name ?? '—'}</span> },
    { key: 'face', header: 'Face', cell: (e) => <StatusPill info={enrollmentInfo(e.enrollment)} /> },
    { key: 'pin', header: 'PIN', cell: (e) => (e.has_pin ? <KeyRound width={16} height={16} aria-label="PIN set" /> : <span className="subtle">—</span>) },
    { key: 'status', header: 'Status', cell: (e) => <StatusPill info={EMPLOYEE_STATUS[e.status]} /> },
  ];

  return (
    <>
      <PageHead
        title="Staff"
        lede="Your team, their shifts and face enrollment status."
        actions={can('employees.write') && <Button variant="primary" icon={UserPlus} onClick={() => setParam('new', '1')}>Add employee</Button>}
      />
      <div className="filters">
        <div className="input-icon">
          <Search aria-hidden />
          <label className="sr-only" htmlFor="staff-q">Search staff</label>
          <Input id="staff-q" type="search" placeholder="Search name or staff ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <SegmentedControl<StatusFilter>
          label="Status"
          value={status}
          onChange={(v) => setParam('status', v === 'active' ? '' : v)}
          options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'deactivated', label: 'Deactivated' }, { value: 'all', label: 'All' }]}
        />
      </div>
      <div className="stack">
        {notEnrolled > 0 && status === 'active' && !q && (
          <Notice tone="info">
            {notEnrolled} active {notEnrolled === 1 ? 'employee has' : 'employees have'} no face enrollment yet. Enroll faces on the kiosk: open <strong>Manager mode</strong>, sign in, then choose the employee. Until then they can use a PIN or manual check-in.
          </Notice>
        )}
        <Card>
          {list.loading && !list.data ? (
            <SkeletonRows rows={6} />
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : !list.data?.length ? (
            <EmptyState icon={Users} title={q ? 'No one matches that search' : status === 'active' ? 'No employees yet' : 'No employees here'} action={!q && status === 'active' && can('employees.write') ? <Button variant="primary" icon={UserPlus} onClick={() => setParam('new', '1')}>Add your first employee</Button> : undefined}>
              {q ? 'Try a different name or staff ID.' : status === 'active' ? 'Add staff, assign their shifts, then enroll their faces on the kiosk.' : undefined}
            </EmptyState>
          ) : (
            <ResponsiveTable
              caption="Employees"
              rows={list.data}
              columns={columns}
              rowKey={(e) => e.id}
              onRowClick={(e) => nav(`/staff/${e.id}`)}
              card={(e) => (
                <div className="mcard-row">
                  <Person name={e.full_name} sub={`${e.staff_id}${e.job_title ? ` · ${e.job_title}` : ''}`} employeeId={e.id} hasPhoto={e.has_photo} />
                  <span className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}>
                    {e.open_session ? <Pill tone="success">Working</Pill> : e.status !== 'active' ? <StatusPill info={EMPLOYEE_STATUS[e.status]} /> : null}
                    <StatusPill info={enrollmentInfo(e.enrollment)} dot={false} />
                  </span>
                </div>
              )}
            />
          )}
        </Card>
      </div>
      <EmployeeForm open={formOpen} onClose={() => setParam('new', '')} onSaved={(e) => nav(`/staff/${e.id}`)} />
    </>
  );
}
