import { api } from './api';
import { useQuery } from './useQuery';
import type { Branch, Employee, Shift } from './types';

export function useBranches() {
  return useQuery((s) => api.get<{ branches: Branch[] }>('/api/branches', undefined, s).then((r) => r.branches), []);
}

export function useShifts() {
  return useQuery((s) => api.get<{ shifts: Shift[] }>('/api/shifts', undefined, s).then((r) => r.shifts), []);
}

export function useEmployees(status: 'active' | 'all' = 'active') {
  return useQuery((s) => api.get<{ employees: Employee[] }>('/api/employees', { status }, s).then((r) => r.employees), [status], { tables: ['employees'] });
}
