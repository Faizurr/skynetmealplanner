import { z } from 'zod';

/**
 * Per-restaurant policy. Stored in restaurants.settings (jsonb); missing keys fall back
 * to these defaults so new settings can be added without data migrations.
 */
export const restaurantSettingsSchema = z.object({
  // Recognition. SFace cosine similarity: higher = more similar. OpenCV's published
  // LFW operating point is 0.363; we default stricter because a false accept records
  // attendance for the wrong person. Tune per site with tools/face-eval.
  match_threshold: z.number().min(0.3).max(0.9).default(0.5),
  /** Best match must beat the best *other* employee by at least this much. */
  match_margin: z.number().min(0).max(0.5).default(0.06),
  liveness_required: z.boolean().default(true),
  pin_fallback_enabled: z.boolean().default(true),

  // Kiosk UX
  success_return_seconds: z.number().int().min(2).max(30).default(4),
  sound_enabled: z.boolean().default(true),
  employee_instructions: z.string().max(200).default('Tap CHECK IN when you arrive and CHECK OUT when you leave.'),

  // Offline
  offline_mode_enabled: z.boolean().default(true),
  max_offline_age_hours: z.number().int().min(1).max(24 * 14).default(72),
  max_clock_skew_minutes: z.number().int().min(1).max(120).default(5),

  // Attendance rules for employees without an assigned shift
  default_unpaid_break_minutes: z.number().int().min(0).max(480).default(0),
  default_break_applies_after_minutes: z.number().int().min(0).max(1440).default(360),
  default_overtime_after_minutes: z.number().int().min(0).max(1440).default(480),
  /** Sessions open longer than this are closed as missing_checkout and flagged. */
  max_session_hours: z.number().int().min(4).max(36).default(16),
  /** Flag a missing checkout this long after the scheduled shift end. */
  missing_checkout_grace_minutes: z.number().int().min(0).max(720).default(90),
  /** Rejects CHECK OUT within N minutes of CHECK IN (accidental double tap protection). */
  min_minutes_between_in_and_out: z.number().int().min(0).max(60).default(1),
  /** How early (minutes) before a shift starts a check-in is attributed to it. */
  early_check_in_window_minutes: z.number().int().min(0).max(720).default(180),

  // Payroll. Daily salary covers a standard day of this many hours; OT per hour = salary ÷ standard hours.
  payroll_standard_hours: z.number().min(1).max(24).default(12),
  /** full = the day salary is paid for any completed day; prorate = pay worked hours for short days. */
  payroll_short_day_policy: z.enum(['full', 'prorate']).default('full'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('MYR'),

  // Reporting
  rounding_minutes: z.number().int().refine((v) => [0, 1, 5, 6, 10, 15, 30].includes(v)).default(0),
  rounding_mode: z.enum(['nearest', 'down', 'up']).default('nearest'),
});

export type RestaurantSettings = z.infer<typeof restaurantSettingsSchema>;

export function resolveSettings(raw: unknown): RestaurantSettings {
  const parsed = restaurantSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Ignore individually invalid keys rather than failing attendance.
  const base = restaurantSettingsSchema.parse({});
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const candidate = restaurantSettingsSchema.safeParse({ ...base, [k]: v });
      if (candidate.success) Object.assign(base, { [k]: (candidate.data as Record<string, unknown>)[k] });
    }
  }
  return base;
}

export function roundMinutes(minutes: number, step: number, mode: RestaurantSettings['rounding_mode']): number {
  if (!step || step <= 1) return minutes;
  const f = mode === 'down' ? Math.floor : mode === 'up' ? Math.ceil : Math.round;
  return f(minutes / step) * step;
}
