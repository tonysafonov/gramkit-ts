import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { getLogger } from '../lib/logging';

const logger = getLogger('core.access');

/**
 * One INFO line per HTTP request: method, path, status, duration. The logger adds the request id and user, so this
 * line says who called what, how it ended and how long it took.
 *
 * The query string is left out on purpose: it can carry the user's own words. A streaming response is logged when its
 * body ends, so its duration is the whole stream.
 */
export const accessLog: MiddlewareHandler<Env> = async (c, next) => {
  const started = performance.now();
  const log = () => {
    const ms = Math.round(performance.now() - started);
    logger.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  };

  try {
    await next();
  } catch (err) {
    logger.info(`${c.req.method} ${c.req.path} 500 ${Math.round(performance.now() - started)}ms`);
    throw err;
  }
  // A handler that failed after `trackStream` has no body to wait for
  const streamDone = c.error ? undefined : c.get('streamDone');
  if (streamDone) void streamDone.finally(log);
  else log();
};
