import { describe, expect, it } from 'vitest';
import { addDaysYmd, fmtClock, fmtDate, fmtDays, fmtDuration, fmtRelative, fmtTime, fmtYmd, initials, isoToLocalInputs, localYmd, zonedToIso } from '../lib/format';

const KL = 'Asia/Kuala_Lumpur';

describe('time formatting (restaurant timezone, en-MY)', () => {
  it('formats times like "9:02 am" in the restaurant timezone', () => {
    expect(fmtTime('2026-10-12T01:02:00Z', KL)).toBe('9:02 am');
    expect(fmtTime('2026-10-12T13:30:00Z', KL)).toBe('9:30 pm');
    expect(fmtTime(null, KL)).toBe('—');
  });
  it('formats dates like "12 Oct 2026" and handles the day boundary in tz', () => {
    expect(fmtDate('2026-10-12T01:02:00Z', KL)).toBe('12 Oct 2026');
    // 20:00 UTC on the 11th is already the 12th in Kuala Lumpur
    expect(fmtDate('2026-10-11T20:00:00Z', KL)).toBe('12 Oct 2026');
    expect(localYmd('2026-10-11T20:00:00Z', KL)).toBe('2026-10-12');
    expect(localYmd('2026-10-11T20:00:00Z', 'Europe/London')).toBe('2026-10-11');
  });
  it('formats local calendar dates without drift', () => {
    expect(fmtYmd('2026-10-12')).toBe('12 Oct 2026');
    expect(fmtYmd('2026-10-12', { weekday: true })).toMatch(/^Mon/);
  });
});

describe('durations', () => {
  it('formats minutes as "8h 36m"', () => {
    expect(fmtDuration(516)).toBe('8h 36m');
    expect(fmtDuration(45)).toBe('45m');
    expect(fmtDuration(60)).toBe('1h 00m');
    expect(fmtDuration(0)).toBe('0m');
    expect(fmtDuration(null)).toBe('—');
  });
});

describe('timezone conversion for forms', () => {
  it('converts restaurant wall-clock time to UTC and back', () => {
    expect(zonedToIso('2026-10-12', '09:05', KL)).toBe('2026-10-12T01:05:00.000Z');
    expect(isoToLocalInputs('2026-10-12T01:05:00.000Z', KL)).toEqual({ date: '2026-10-12', time: '09:05' });
  });
  it('is DST-safe (London, after the October change)', () => {
    expect(zonedToIso('2026-10-26', '09:00', 'Europe/London')).toBe('2026-10-26T09:00:00.000Z');
    expect(zonedToIso('2026-07-01', '09:00', 'Europe/London')).toBe('2026-07-01T08:00:00.000Z');
  });
  it('adds days across month ends', () => {
    expect(addDaysYmd('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('misc', () => {
  it('relative times', () => {
    const now = new Date('2026-10-12T10:00:00Z');
    expect(fmtRelative('2026-10-12T09:59:50Z', now)).toBe('just now');
    expect(fmtRelative('2026-10-12T09:50:00Z', now)).toBe('10 min ago');
    expect(fmtRelative('2026-10-12T07:00:00Z', now)).toBe('3 h ago');
    expect(fmtRelative(null, now)).toBe('never');
  });
  it('shift helpers', () => {
    expect(fmtClock('09:00')).toBe('9:00 am');
    expect(fmtClock('00:30')).toBe('12:30 am');
    expect(fmtClock('12:00')).toBe('12:00 pm');
    expect(fmtDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(fmtDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(fmtDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(fmtDays([2, 3, 4, 6])).toBe('Tue–Thu, Sat');
  });
  it('initials', () => {
    expect(initials('Mei Ling Wong')).toBe('MW');
    expect(initials('Aisyah')).toBe('A');
    expect(initials('')).toBe('?');
  });
});
