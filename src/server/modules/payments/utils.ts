const UUID_HEX = /^[0-9a-f]{32}$/i;

/** Python's `UUID(value)`: the forms it accepts, in canonical form, or `null` where it raises. */
export function parseUuid(value: string): string | null {
  const hex = value
    .replace('urn:', '')
    .replace('uuid:', '')
    .replace(/^[{}]+|[{}]+$/g, '')
    .replaceAll('-', '');
  if (!UUID_HEX.test(hex)) return null;
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

/**
 * Python's `datetime.isoformat()` for a UTC instant: `2026-06-18T12:00:00+00:00`, microseconds when there is a fraction.
 * Idempotency keys and stored timestamps stay in the format the Python app wrote.
 */
export function isoformat(date: Date): string {
  const [seconds, millis] = date.toISOString().slice(0, -1).split('.');
  return millis === '000' ? `${seconds}+00:00` : `${seconds}.${millis}000+00:00`;
}

/** A timestamp at full precision: Python's `isoformat()` of it, from `isoformatFromPg`. */
export interface ExactTimestamp {
  isoformat: string;
}

/**
 * `isoformat` of a timestamp Postgres rendered at full precision with `PG_ISO_UTC` (`2026-06-18T12:00:00.123456`).
 * A `Date` keeps milliseconds only, so a Python-written value (microseconds) needs this to come out as Python's.
 */
export function isoformatFromPg(text: string): string {
  const [seconds, micros = ''] = text.split('.');
  return /^0*$/.test(micros) ? `${seconds}+00:00` : `${seconds}.${micros.padEnd(6, '0')}+00:00`;
}

/** `to_char` format for `isoformatFromPg`, applied to `<timestamptz> AT TIME ZONE 'UTC'`. */
export const PG_ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US';

const DAY_MS = 86_400_000;

export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

/** Whole days between two instants: Python's `timedelta.days`. */
export const daysBetween = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
