/** Maps raw API states to the labels and tones shown in the UI. Pure & tested. */
import type { AttendanceEvent, RosterStatus, SessionStatus } from './types';

export type Tone = 'success' | 'warning' | 'attention' | 'error' | 'neutral' | 'info' | 'accent';

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** Longer explanation for tooltips / detail sheets. */
  hint?: string;
}

export type VerificationKind = 'verified' | 'offline_synced' | 'awaiting_review' | 'rejected' | 'manual' | 'corrected';

/**
 * Verification badge for an attendance event. A pending_review event is NEVER shown as verified.
 * Priority: rejected > awaiting review > corrected > manual > offline-synced > verified.
 */
export function eventVerification(e: Pick<AttendanceEvent, 'verification_status' | 'recorded_offline' | 'source' | 'exception_flags'>): VerificationKind {
  if (e.verification_status === 'rejected') return 'rejected';
  if (e.verification_status === 'pending_review') return 'awaiting_review';
  if (e.verification_status !== 'verified') return 'awaiting_review';
  if (e.exception_flags?.includes('correction')) return 'corrected';
  if (e.source === 'manual') return 'manual';
  if (e.recorded_offline) return 'offline_synced';
  return 'verified';
}

export const VERIFICATION_INFO: Record<VerificationKind, StatusInfo> = {
  verified: { label: 'Verified', tone: 'success', hint: 'Confirmed by the kiosk and the server at the time it happened.' },
  offline_synced: { label: 'Offline-synced', tone: 'info', hint: 'Recorded while the kiosk was offline, verified when it reconnected. Time is the device time.' },
  awaiting_review: { label: 'Awaiting review', tone: 'attention', hint: 'Not counted as verified until a manager approves it.' },
  rejected: { label: 'Rejected', tone: 'error', hint: 'A manager rejected this event; it does not count toward hours.' },
  manual: { label: 'Manual', tone: 'neutral', hint: 'Entered by a manager in the dashboard.' },
  corrected: { label: 'Corrected', tone: 'accent', hint: 'Created or changed by an approved correction.' },
};

export const ROSTER_INFO: Record<RosterStatus, StatusInfo> = {
  working: { label: 'Working', tone: 'success' },
  unscheduled_working: { label: 'Working · unscheduled', tone: 'success' },
  late_not_arrived: { label: 'Late · not arrived', tone: 'warning' },
  not_yet_due: { label: 'Not yet due', tone: 'neutral' },
  checked_out: { label: 'Checked out', tone: 'neutral' },
  absent: { label: 'Absent', tone: 'error' },
};

/** Display order for roster groups: who is working first. */
export const ROSTER_ORDER: RosterStatus[] = ['working', 'unscheduled_working', 'late_not_arrived', 'not_yet_due', 'checked_out', 'absent'];

export function sessionStatusInfo(s: { status: SessionStatus; needs_review?: boolean }): StatusInfo {
  if (s.needs_review && s.status !== 'voided') return { label: 'Needs review', tone: 'attention' };
  switch (s.status) {
    case 'open':
      return { label: 'Working', tone: 'success' };
    case 'closed':
      return { label: 'Complete', tone: 'neutral' };
    case 'missing_checkout':
      return { label: 'Missing check-out', tone: 'warning' };
    case 'voided':
      return { label: 'Voided', tone: 'error' };
    default:
      return { label: String(s.status), tone: 'neutral' };
  }
}

export const EXCEPTION_TITLES: Record<string, string> = {
  late_arrival: 'Late arrival',
  missing_checkout: 'Missing check-out',
  unknown_face: 'Unrecognised face at kiosk',
  offline_conflict: 'Offline event needs review',
  clock_skew: 'Kiosk clock is wrong',
  device_offline: 'Kiosk offline',
  sync_failure: 'Kiosk could not sync an event',
  identity_mismatch: 'Identity mismatch',
  overtime: 'Overtime recorded',
};

export function exceptionTitle(kind: string): string {
  return EXCEPTION_TITLES[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function severityTone(sev: string): Tone {
  if (sev === 'critical') return 'error';
  if (sev === 'warning') return 'warning';
  return 'neutral';
}

export const FLAG_LABELS: Record<string, string> = {
  pin_fallback: 'PIN used',
  manual_entry: 'Manual entry',
  offline: 'Recorded offline',
  clock_skew: 'Clock skew',
  stale_offline: 'Old offline event',
  device_clock_skew: 'Device clock off',
  offline_conflict: 'Offline conflict',
  late: 'Late',
  checkout_before_checkin: 'Out before in',
  overtime: 'Overtime',
  correction: 'Correction',
};

export function flagLabel(f: string): string {
  return FLAG_LABELS[f] ?? f.replace(/_/g, ' ');
}

export const SOURCE_LABELS: Record<string, string> = { kiosk_face: 'Face', kiosk_pin: 'PIN', manual: 'Manual' };

export const CONSENT_LABELS: Record<string, string> = {
  written_form: 'Written consent form',
  digital_acknowledgement: 'Digital acknowledgement',
  verbal_witnessed: 'Verbal, witnessed',
};

export const ROLE_LABELS: Record<string, string> = { owner: 'Owner', manager: 'Manager', attendance_admin: 'Attendance admin' };

export const DELIVERY_TONE: Record<string, Tone> = { queued: 'neutral', sending: 'info', sent: 'success', failed: 'error', suppressed: 'warning' };

export const EMPLOYEE_STATUS: Record<string, StatusInfo> = {
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'warning' },
  deactivated: { label: 'Deactivated', tone: 'neutral' },
};

export function enrollmentInfo(e: { status: string } | null | undefined): StatusInfo {
  if (!e) return { label: 'Not enrolled', tone: 'neutral' };
  switch (e.status) {
    case 'active':
      return { label: 'Face enrolled', tone: 'success' };
    case 'pending_confirmation':
      return { label: 'Awaiting confirmation', tone: 'attention' };
    case 'revoked':
      return { label: 'Revoked', tone: 'neutral' };
    case 'deleted':
      return { label: 'Deleted', tone: 'neutral' };
    default:
      return { label: e.status, tone: 'neutral' };
  }
}
