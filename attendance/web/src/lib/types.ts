export type Permission =
  | 'attendance.read' | 'attendance.manual' | 'attendance.review' | 'corrections.request' | 'corrections.approve'
  | 'employees.read' | 'employees.write' | 'biometrics.manage' | 'shifts.write' | 'devices.manage'
  | 'notifications.manage' | 'settings.manage' | 'team.manage' | 'audit.read' | 'reports.export';

export type Role = 'owner' | 'manager' | 'attendance_admin';

export interface Me {
  user: { id: string; email: string; full_name: string; must_change_password: boolean };
  role: Role;
  permissions: Permission[];
  restaurant: { id: string; name: string; timezone: string };
  memberships: { restaurant_id: string; name: string; role: Role }[];
}

export type RosterStatus = 'late_not_arrived' | 'working' | 'unscheduled_working' | 'not_yet_due' | 'checked_out' | 'absent';

export interface RosterRow {
  employee: { id: string; full_name: string; staff_id: string; branch_id: string | null; status: string; job_title: string | null };
  status: RosterStatus;
  scheduled_start: string | null;
  scheduled_end: string | null;
  shift_name: string | null;
  check_in_at: string | null;
  check_out_at: string | null;
  is_late: boolean;
  late_minutes: number;
  worked_minutes: number | null;
}

export interface DeviceLite {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'revoked';
  last_seen_at: string | null;
  pending_queue_count: number;
  app_version: string | null;
  last_error: string | null;
  online: boolean;
}

export interface Overview {
  date: string;
  timezone: string;
  metrics: {
    expected_today: number; currently_working: number; checked_out: number; not_yet_arrived: number; late_not_arrived: number;
    absent: number; late_arrivals: number; missing_checkouts: number; pending_review: number; pending_corrections: number;
    pending_enrollments: number; open_exceptions: number; devices_offline: number; devices_with_unsynced_events: number;
  };
  exceptions_by_kind: Record<string, number>;
  roster: RosterRow[];
  devices: DeviceLite[];
}

export type VerificationStatus = 'verified' | 'pending_review' | 'rejected';

export interface AttendanceEvent {
  id: string;
  event_type: 'check_in' | 'check_out';
  event_time: string;
  device_timestamp: string | null;
  server_received_at: string;
  source: 'kiosk_face' | 'kiosk_pin' | 'manual';
  verification_status: VerificationStatus;
  recorded_offline: boolean;
  match_score: number | null;
  exception_flags: string[];
  note: string | null;
  session_id: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  employee_id: string;
  full_name: string;
  staff_id: string;
  has_photo: boolean;
  branch_name: string | null;
  device_name: string | null;
  scheduled_start: string | null;
  is_late: boolean | null;
  late_minutes: number | null;
  worked_minutes: number | null;
  is_corrected: boolean | null;
  session_status: SessionStatus | null;
}

export type SessionStatus = 'open' | 'closed' | 'missing_checkout' | 'voided';

export interface Session {
  id: string;
  status: SessionStatus;
  employee_id: string;
  full_name: string;
  staff_id: string;
  branch_name: string | null;
  check_in_at: string;
  check_out_at: string | null;
  corrected_check_in_at: string | null;
  corrected_check_out_at: string | null;
  effective_check_in: string;
  effective_check_out: string | null;
  is_corrected: boolean;
  scheduled_start: string | null;
  scheduled_end: string | null;
  shift_name: string | null;
  late_minutes: number;
  is_late: boolean;
  break_minutes: number;
  worked_minutes: number | null;
  overtime_minutes: number;
  needs_review: boolean;
}

export interface Enrollment {
  id: string;
  status: 'pending_confirmation' | 'active' | 'revoked' | 'deleted';
  created_at: string;
  confirmed_at?: string | null;
  template_count: number;
  consent_method: string | null;
}

export interface Employee {
  id: string;
  staff_id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  department: string | null;
  email: string | null;
  status: 'active' | 'suspended' | 'deactivated';
  branch_id: string | null;
  branch_name: string | null;
  has_pin: boolean;
  has_photo: boolean;
  enrollment: Enrollment | null;
  shifts: { id: string; name: string; start_time: string; end_time: string }[];
  open_session: { id: string; check_in_at: string } | null;
  created_at?: string;
}

export interface EnrollmentHistory extends Enrollment {
  model: string;
  consent_notice_version: string | null;
  consent_recorded_at: string | null;
  revoked_at: string | null;
  deleted_at: string | null;
  enrolled_by: string | null;
  confirmed_by: string | null;
}

export interface PendingEnrollment {
  id: string;
  status: string;
  created_at: string;
  template_count: number;
  consent_method: string | null;
  employee_id: string;
  full_name: string;
  staff_id: string;
  has_photo: boolean;
  enrolled_by: string | null;
  device_name: string | null;
}

export type ExceptionKind = 'late_arrival' | 'missing_checkout' | 'unknown_face' | 'offline_conflict' | 'clock_skew' | 'device_offline' | 'sync_failure' | 'identity_mismatch' | 'overtime';

export interface AlertRow {
  id: string;
  kind: ExceptionKind | string;
  severity: 'info' | 'warning' | 'critical' | string;
  status: 'open' | 'resolved';
  details: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  session_id: string | null;
  event_id: string | null;
  employee_id: string | null;
  full_name: string | null;
  staff_id: string | null;
  device_name: string | null;
  device_id: string | null;
}

export interface Correction {
  id: string;
  kind: 'adjust_times' | 'add_session' | 'void_session';
  session_id: string | null;
  employee_id: string;
  original_values: Record<string, string | null> | null;
  new_values: { check_in_at: string | null; check_out_at: string | null } | null;
  reason: string;
  status: 'requested' | 'approved' | 'rejected';
  full_name?: string;
  staff_id?: string;
  requested_by: string | null;
  decided_by: string | null;
  decision_note?: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  active: boolean;
  employee_count: number;
  device_count: number;
}

export interface Shift {
  id: string;
  name: string;
  branch_id: string | null;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  grace_minutes: number;
  unpaid_break_minutes: number;
  break_applies_after_minutes: number;
  overtime_after_minutes: number | null;
  active: boolean;
  overnight: boolean;
  employee_count: number;
}

export interface Device extends DeviceLite {
  branch_id: string | null;
  branch_name: string | null;
  device_model: string | null;
  last_sync_at: string | null;
  created_at: string;
  paired_at: string | null;
  revoked_at: string | null;
  pairing_expires_at: string | null;
}

export interface PairingInfo {
  device_id?: string;
  pairing_code: string;
  expires_at: string;
  server_url: string;
}

export interface RestaurantSettings {
  match_threshold: number;
  match_margin: number;
  liveness_required: boolean;
  pin_fallback_enabled: boolean;
  success_return_seconds: number;
  sound_enabled: boolean;
  employee_instructions: string;
  offline_mode_enabled: boolean;
  max_offline_age_hours: number;
  max_clock_skew_minutes: number;
  default_unpaid_break_minutes: number;
  default_break_applies_after_minutes: number;
  default_overtime_after_minutes: number;
  max_session_hours: number;
  missing_checkout_grace_minutes: number;
  min_minutes_between_in_and_out: number;
  early_check_in_window_minutes: number;
  rounding_minutes: number;
  rounding_mode: 'nearest' | 'down' | 'up';
}

export interface NotificationSettings {
  emails: string[];
  on_check_in: boolean;
  on_check_out: boolean;
  important_only: boolean;
  late_arrival: boolean;
  missing_checkout: boolean;
  unknown_face: boolean;
  suspicious_events: boolean;
  device_offline: boolean;
  sync_failure: boolean;
  daily_summary: boolean;
  daily_summary_time: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  include_staff_id: boolean;
}

export interface Delivery {
  id: string;
  kind: string;
  subject: string;
  to_addresses: string[];
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed';
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string | null;
  not_before: string | null;
}

export interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  last_login_at: string | null;
  disabled: boolean;
  created_at: string;
}

export interface AuditEntry {
  id: number | string;
  actor_type: string;
  actor_name: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface Analytics {
  from: string;
  to: string;
  timezone: string;
  summary: {
    scheduled_shifts: number; attended_scheduled_shifts: number; total_sessions: number; punctuality_rate: number | null;
    late_arrivals: number; late_frequency: number | null; average_lateness_minutes: number | null; absences: number;
    attendance_rate: number | null; missing_checkouts: number; average_worked_minutes: number | null;
    total_worked_minutes: number; total_overtime_minutes: number;
  };
  daily: { date: string; scheduled: number; attended: number; late: number; absences: number; worked_minutes: number; sessions: number; missing_checkouts: number }[];
  by_weekday: { weekday: number; name: string; sessions: number; late: number; scheduled_sessions: number; missing_checkouts: number; absences: number; late_rate: number | null }[];
  arrival_by_hour: { hour: number; check_ins: number; late: number }[];
  by_branch: { branch_id: string; name: string; sessions: number; late: number; scheduled_sessions: number; worked_minutes: number; missing_checkouts: number; late_rate: number | null }[];
  by_shift: { shift_id: string; name: string; sessions: number; late: number; missing_checkouts: number; late_rate: number | null }[];
  employees: {
    employee_id: string; full_name: string; staff_id: string; scheduled: number; attended: number; late: number; absences: number;
    worked_minutes: number; overtime_minutes: number; missing_checkouts: number; sessions: number; punctuality_rate: number | null;
    consistency: number | null; average_lateness_minutes: number | null;
  }[];
  absences: { employee_id: string; date: string; shift: string }[];
  insights: { id: string; severity: 'info' | 'warning'; title: string; detail: string; employee_ids?: string[] }[];
}
