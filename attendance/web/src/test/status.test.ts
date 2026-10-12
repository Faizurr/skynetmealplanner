import { describe, expect, it } from 'vitest';
import { eventVerification, exceptionTitle, sessionStatusInfo, VERIFICATION_INFO, enrollmentInfo } from '../lib/status';

const base = { verification_status: 'verified' as const, recorded_offline: false, source: 'kiosk_face' as const, exception_flags: [] as string[] };

describe('event verification badges', () => {
  it('never shows pending_review as verified, even if offline/manual/corrected', () => {
    for (const extra of [{}, { recorded_offline: true }, { source: 'manual' as const }, { exception_flags: ['correction'] }]) {
      const k = eventVerification({ ...base, ...extra, verification_status: 'pending_review' });
      expect(k).toBe('awaiting_review');
      expect(VERIFICATION_INFO[k].label).toBe('Awaiting review');
      expect(VERIFICATION_INFO[k].tone).not.toBe('success');
    }
  });
  it('maps the distinct states', () => {
    expect(eventVerification(base)).toBe('verified');
    expect(eventVerification({ ...base, recorded_offline: true })).toBe('offline_synced');
    expect(eventVerification({ ...base, source: 'manual' })).toBe('manual');
    expect(eventVerification({ ...base, source: 'manual', exception_flags: ['correction'] })).toBe('corrected');
    expect(eventVerification({ ...base, verification_status: 'rejected' })).toBe('rejected');
  });
  it('has six distinct labels', () => {
    const labels = Object.values(VERIFICATION_INFO).map((v) => v.label);
    expect(new Set(labels).size).toBe(6);
  });
});

describe('session & alert labels', () => {
  it('session status', () => {
    expect(sessionStatusInfo({ status: 'missing_checkout' }).label).toBe('Missing check-out');
    expect(sessionStatusInfo({ status: 'open', needs_review: true }).label).toBe('Needs review');
    expect(sessionStatusInfo({ status: 'voided', needs_review: true }).label).toBe('Voided');
  });
  it('alert titles are human readable, with a fallback', () => {
    expect(exceptionTitle('unknown_face')).toBe('Unrecognised face at kiosk');
    expect(exceptionTitle('something_new')).toBe('Something new');
  });
  it('enrollment', () => {
    expect(enrollmentInfo(null).label).toBe('Not enrolled');
    expect(enrollmentInfo({ status: 'pending_confirmation' }).tone).toBe('attention');
  });
});
