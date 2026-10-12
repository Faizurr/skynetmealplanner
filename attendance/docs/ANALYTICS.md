# Attendance metrics: definitions

All metrics are deterministic calculations over stored sessions and shift schedules in the restaurant time zone
(`server/src/analytics.ts`). No AI model generates numbers. Voided sessions are excluded. Approved corrections are used
where present.

| Metric | Definition |
|---|---|
| Scheduled shift | A shift assignment occurrence that starts on a given local date (from the employee's assigned shifts, days of week, effective dates) |
| Attended | A session linked to that occurrence (check-in matched to the shift window: from `early_check_in_window_minutes` before start until shift end) |
| Absence | A scheduled shift that has **ended** with no linked session. Future/ongoing shifts never count as absences |
| Late arrival | Check-in later than scheduled start + the shift's grace minutes |
| Punctuality rate | On-time attended scheduled shifts ÷ attended scheduled shifts |
| Late frequency | Late ÷ attended scheduled shifts |
| Average lateness | Mean minutes late, over late arrivals only |
| Attendance rate | Attended ÷ (attended + absences) |
| Missing check-out | Session closed as `missing_checkout`, or still open after its scheduled end |
| Worked minutes | (check-out − check-in) − unpaid break (if the raw span reaches the break threshold) |
| Overtime | Worked minutes beyond the shift's overtime threshold (default: the scheduled paid length) |
| Consistency (per employee) | Attended ÷ (attended + absences) |
| Arrival pattern | Check-ins by local hour and weekday |

Unscheduled sessions (employees with no shift that day) count toward hours, not toward punctuality or absence.
Metrics with no denominator show "—" rather than 0%.

**Insights** are rule-based and appear only when the data meets the rule, with the supporting numbers:
repeated lateness (>15 min late on ≥3 of an employee's last 7 scheduled shifts, with ≥4 shifts of history), a shift with
≥1.5× the average missing check-out rate (≥2 occurrences, ≥3 sessions), the weekday with the worst late rate (≥5 samples
on each of ≥3 weekdays, ≥1.5× overall, ≥3 late), records awaiting review, one employee holding ≥40% of overtime (≥2h
total), and punctuality changing ≥5 points vs the previous equal period (≥10 scheduled sessions in each). They describe
patterns, not intent, and say nothing about anyone's honesty.

**Payroll exports are provisional**: they reflect recorded attendance and configured rules. Review corrections, leave and
your payroll policy before paying wages.
