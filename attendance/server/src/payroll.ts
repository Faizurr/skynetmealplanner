import type { Tx } from './db.js';
import type { RestaurantCtx } from './attendance.js';
import { roundMinutes, type RestaurantSettings } from './settings.js';
import { localDate } from './time.js';

/**
 * Pay rules (agreed with the restaurant):
 *  - Each employee has a DAILY salary that covers a standard day of `payroll_standard_hours` (default 12 h).
 *  - Overtime per hour = daily salary ÷ standard hours (so 12 h → salary/12 per OT hour), paid per minute.
 *  - OT minutes = worked minutes beyond the standard day (after unpaid breaks), rounded with the
 *    restaurant's reporting rounding (default: exact minutes).
 *  - Short days: 'full' pays the full day salary (default); 'prorate' pays worked/standard of it.
 * All money is integer sen (cents) to avoid floating-point drift.
 */
export interface PayInput {
  workedMinutes: number;
  dailyRateCents: number;
  settings: Pick<RestaurantSettings, 'payroll_standard_hours' | 'payroll_short_day_policy' | 'rounding_minutes' | 'rounding_mode'>;
}

export interface PayBreakdown {
  standardMinutes: number;
  otMinutes: number;
  baseCents: number;
  otCents: number;
  /** Hourly OT rate in sen, may be fractional (e.g. 1250.0 for RM150/12 h). */
  hourlyCents: number;
}

export function computePay({ workedMinutes, dailyRateCents, settings }: PayInput): PayBreakdown {
  const standardMinutes = Math.round(settings.payroll_standard_hours * 60);
  const worked = Math.max(0, Math.floor(workedMinutes));
  const rawOt = Math.max(0, worked - standardMinutes);
  const otMinutes = Math.max(0, roundMinutes(rawOt, settings.rounding_minutes, settings.rounding_mode));
  const baseCents =
    settings.payroll_short_day_policy === 'prorate' && worked < standardMinutes
      ? Math.round((dailyRateCents * worked) / standardMinutes)
      : dailyRateCents;
  const otCents = Math.round((dailyRateCents * otMinutes) / standardMinutes);
  return { standardMinutes, otMinutes, baseCents, otCents, hourlyCents: (dailyRateCents * 60) / standardMinutes };
}

/** Parses a ringgit amount like 150, "150.5" or 150.50 into sen. Rejects more than 2 decimals. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error('invalid amount');
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) throw new Error('amounts can have at most 2 decimals');
  return cents;
}

export async function currentRateCents(tx: Tx, employeeId: string, onDate: string): Promise<number | null> {
  const r = await tx.query<{ daily_rate_cents: number }>(
    `SELECT daily_rate_cents FROM employee_pay_rates WHERE employee_id = $1 AND effective_from <= $2::date
      ORDER BY effective_from DESC LIMIT 1`,
    [employeeId, onDate],
  );
  return r.rows[0]?.daily_rate_cents ?? null;
}

export interface PayoutRow {
  id: string;
  employee_id: string;
  session_id: string;
  status: 'pending' | 'paid' | 'void';
  total_cents: number;
  base_cents: number;
  ot_cents: number;
  ot_minutes: number;
  worked_minutes: number;
  rate_missing: boolean;
  needs_review: boolean;
}

const PAYOUT_COLS = 'id, employee_id, session_id, status, total_cents, base_cents, ot_cents, ot_minutes, worked_minutes, rate_missing, needs_review';

/**
 * Creates or refreshes the payout for one attendance session. Called at check-out and whenever the
 * session's times change (corrections, reviews). Never alters a paid payout: if the numbers would
 * change it is flagged for review instead. Returns null when the session is not payable yet.
 */
export async function syncPayoutForSession(tx: Tx, r: RestaurantCtx, sessionId: string): Promise<PayoutRow | null> {
  const s = (
    await tx.query<{
      id: string; employee_id: string; status: string; needs_review: boolean; worked_minutes: number | null;
      eff_in: Date; eff_out: Date | null;
    }>(
      `SELECT id, employee_id, status, needs_review, worked_minutes,
              COALESCE(corrected_check_in_at, check_in_at) AS eff_in, COALESCE(corrected_check_out_at, check_out_at) AS eff_out
         FROM attendance_sessions WHERE id = $1 AND restaurant_id = $2`,
      [sessionId, r.id],
    )
  ).rows[0];
  if (!s) return null;
  const existing = (await tx.query<PayoutRow>(`SELECT ${PAYOUT_COLS} FROM payouts WHERE session_id = $1 FOR UPDATE`, [sessionId])).rows[0] ?? null;

  const payable = s.status === 'closed' && s.eff_out != null && s.worked_minutes != null;
  if (!payable) {
    if (existing?.status === 'pending') {
      return (await tx.query<PayoutRow>(
        `UPDATE payouts SET status = 'void', updated_at = now(), review_reason = 'Attendance session no longer complete' WHERE id = $1 RETURNING ${PAYOUT_COLS}`,
        [existing.id],
      )).rows[0];
    }
    if (existing?.status === 'paid') {
      await tx.query(`UPDATE payouts SET needs_review = true, review_reason = 'Attendance was changed after payment' WHERE id = $1`, [existing.id]);
    }
    return existing;
  }

  const workDate = localDate(s.eff_in, r.timezone);
  const rate = await currentRateCents(tx, s.employee_id, workDate);
  const pay = computePay({ workedMinutes: s.worked_minutes!, dailyRateCents: rate ?? 0, settings: r.settings });
  const reviewReason = s.needs_review ? 'Attendance is awaiting manager review' : null;

  if (existing?.status === 'paid') {
    const newTotal = pay.baseCents + pay.otCents;
    const oldTotal = existing.base_cents + existing.ot_cents;
    if (newTotal !== oldTotal || existing.worked_minutes !== s.worked_minutes) {
      await tx.query(`UPDATE payouts SET needs_review = true, review_reason = 'Attendance was changed after payment' WHERE id = $1`, [existing.id]);
    }
    return existing;
  }

  if (existing) {
    return (await tx.query<PayoutRow>(
      `UPDATE payouts SET status = 'pending', work_date = $2, check_in_at = $3, check_out_at = $4, worked_minutes = $5,
              standard_minutes = $6, ot_minutes = $7, daily_rate_cents = $8, base_cents = $9, ot_cents = $10,
              total_cents = GREATEST(0, $9::int + $10::int + adjustment_cents), rate_missing = $11, needs_review = $12, review_reason = $13, updated_at = now()
        WHERE id = $1 RETURNING ${PAYOUT_COLS}`,
      [existing.id, workDate, s.eff_in, s.eff_out, s.worked_minutes, pay.standardMinutes, pay.otMinutes, rate ?? 0, pay.baseCents, pay.otCents,
        rate == null, reviewReason != null, reviewReason],
    )).rows[0];
  }
  return (await tx.query<PayoutRow>(
    `INSERT INTO payouts (restaurant_id, employee_id, session_id, work_date, check_in_at, check_out_at, worked_minutes, standard_minutes,
            ot_minutes, daily_rate_cents, base_cents, ot_cents, total_cents, rate_missing, needs_review, review_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::int,$12::int,$11::int + $12::int,$13,$14,$15) RETURNING ${PAYOUT_COLS}`,
    [r.id, s.employee_id, sessionId, workDate, s.eff_in, s.eff_out, s.worked_minutes, pay.standardMinutes, pay.otMinutes, rate ?? 0,
      pay.baseCents, pay.otCents, rate == null, reviewReason != null, reviewReason],
  )).rows[0];
}

/** After the owner changes a salary, refresh pending payouts it applies to (paid ones never change). */
export async function refreshPendingPayouts(tx: Tx, r: RestaurantCtx, employeeId: string, fromDate: string): Promise<number> {
  const rows = await tx.query<{ session_id: string }>(
    `SELECT session_id FROM payouts WHERE employee_id = $1 AND status = 'pending' AND (work_date >= $2::date OR rate_missing)`,
    [employeeId, fromDate],
  );
  for (const row of rows.rows) await syncPayoutForSession(tx, r, row.session_id);
  return rows.rowCount ?? 0;
}

export function formatMoney(cents: number, currency = 'MYR'): string {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}
