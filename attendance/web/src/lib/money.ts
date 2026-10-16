/** Money helpers. Amounts travel as integer sen (cents) and are formatted with Intl. */
export function fmtMoney(cents: number | null | undefined, currency = 'MYR', opts: { sign?: boolean } = {}): string {
  if (cents == null) return '—';
  const f = new Intl.NumberFormat('en-MY', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const s = f.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  return opts.sign && cents > 0 ? `+${s}` : s;
}

/** Hourly OT rate in sen (may be fractional) → "RM12.50". */
export function fmtRate(hourlyCents: number, currency = 'MYR'): string {
  return fmtMoney(Math.round(hourlyCents), currency);
}

/** Parses user input like "150", "150.5", "RM 1,200.00" into a number of ringgit (or null if invalid). */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function hourlyFromDaily(dailyCents: number, standardHours: number): number {
  return dailyCents / standardHours;
}
