import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { settings } from '../config';
import type { UserEnv } from '../env';
import { RateLimitExceededError } from '../lib/errors';
import { getLogger } from '../lib/logging';

const logger = getLogger('rate-limit');

export const SOFT_LIMIT = '100/minute';
export const HARD_LIMIT = '10/minute';
export const READING_LIMIT = '100/day';

const PERIODS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400 };

function parseLimit(limit: string): { count: number; period: string; seconds: number } {
  const [count, period] = limit.split('/');
  const seconds = PERIODS[period ?? ''];
  if (!count || !period || !seconds) throw new Error(`Bad rate limit: ${limit}`);
  return { count: Number(count), period, seconds };
}

/**
 * Fixed-window limit per user per route, slowapi's defaults, in Redis so workers share it. Chain it after `getUser`.
 * A rate limiter must not take the API down with it: when Redis fails the request goes through.
 */
export function rateLimit(limit: string): MiddlewareHandler<UserEnv> {
  const { count, period, seconds } = parseLimit(limit);

  return async (c, next) => {
    if (!settings.rateLimit.enabled) return next();

    const window = Math.floor(Date.now() / 1000 / seconds);
    const key = `rate:${c.get('user').id}:${c.req.method}:${routePath(c)}:${limit}:${window}`;
    const { redis } = c.get('state').clients;
    let hits = 0;
    try {
      hits = await redis.incr(key);
      if (hits === 1) await redis.expire(key, seconds);
    } catch (err) {
      logger.warn({ err }, 'Rate limit check failed, letting the request through');
    }
    if (hits > count) throw new RateLimitExceededError(`${count} per 1 ${period}`);
    return next();
  };
}
