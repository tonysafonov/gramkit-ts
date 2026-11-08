/** Wire shapes and query/body validation of the demo endpoints (Python's `routers/demo.py`). */
import { z } from 'zod';

const INT = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** An integer query parameter with FastAPI's `ge` / `le` and default: a malformed or out-of-range value is a 422. */
export const intQuery = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .regex(INT, 'Input should be a valid integer, unable to parse string as an integer')
    .transform(Number)
    .pipe(z.number().min(min).max(max))
    .optional()
    .transform((value) => value ?? defaultValue);

export const floatQuery = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .regex(FLOAT, 'Input should be a valid number, unable to parse string as a number')
    .transform(Number)
    .pipe(z.number().min(min).max(max))
    .optional()
    .transform((value) => value ?? defaultValue);

export const stringQuery = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => value ?? defaultValue);

export const SlowQuery = z.object({ delay_ms: intQuery(2000, 100, 10000) });
export const UnreliableQuery = z.object({ fail_rate: floatQuery(0.5, 0, 1) });
export const CounterQuery = z.object({ counter_id: stringQuery('default') });
export const IncrementQuery = z.object({
  counter_id: stringQuery('default'),
  amount: intQuery(1, 1, 100),
  should_fail: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 't', 'f', 'y', 'n'])
    .optional()
    .transform((value) => value !== undefined && ['true', '1', 'yes', 'on', 't', 'y'].includes(value)),
});
export const ItemsQuery = z.object({
  cursor: intQuery(0, 0, Number.MAX_SAFE_INTEGER),
  limit: intQuery(10, 1, 50),
  delay_ms: intQuery(500, 0, 3000),
});
export const DelayQuery = (defaultMs: number) => z.object({ delay_ms: intQuery(defaultMs, 0, 3000) });
export const WeatherQuery = z.object({ city: stringQuery('Moscow'), delay_ms: intQuery(800, 0, 3000) });
export const StockQuery = z.object({ symbol: stringQuery('DEMO'), delay_ms: intQuery(600, 0, 3000) });

export const IntParam = (name: string) =>
  z.object({ [name]: z.string().regex(INT, 'Input should be a valid integer') });

export const NotifyRequest = z.object({ delay_seconds: z.number().int().default(5) });
export const SetRoleRequest = z.object({ role: z.string() });

/** Python's `datetime.isoformat()` for a UTC instant: microseconds and `+00:00`. */
export const isoformat = (date: Date = new Date()): string => date.toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');

/** Python's `str(float)`: whole numbers keep their ".0". */
export const pyFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));
