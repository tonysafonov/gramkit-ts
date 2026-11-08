/** Pure helpers of the money analytics. */

export const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/**
 * Period-over-period growth %, or `null` when the prior window is zero. Growth from zero is undefined, not
 * "infinite", so there is no number to fabricate. A 0 prior with a 0 current is also `null`.
 */
export const growthPct = (current: number, previous: number): number | null =>
  previous === 0 ? null : ((current - previous) / previous) * 100;

/** Monday 00:00 UTC of the week containing `moment` (matches `date_trunc('week')`). */
export function weekStart(moment: Date): Date {
  const day = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 86_400_000);
}

/** ISO date (`YYYY-MM-DD`) of an instant, in UTC. */
export const isoDate = (moment: Date): string => moment.toISOString().slice(0, 10);

/** Python's `round(x, digits)`: the exact decimal value of the float, ties to even. */
export function roundHalfEven(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const exact = Math.abs(value).toFixed(20);
  const [, fraction = ''] = exact.split('.');
  const rest = fraction.slice(digits);
  const isTie = /^50*$/.test(rest);
  if (!isTie) return Number(value.toFixed(digits));
  const down = Number(exact.slice(0, exact.length - rest.length));
  const lastDigit = Number(fraction[digits - 1] ?? exact.split('.')[0]?.slice(-1));
  const rounded = lastDigit % 2 === 0 ? down : down + 10 ** -digits;
  return Number((Math.sign(value) * rounded).toFixed(digits));
}
