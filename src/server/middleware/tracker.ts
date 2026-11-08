import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { getLogger } from '../lib/logging';

const logger = getLogger('tracker');

const DRAIN_POLL_MS = 100;

/** Counts active requests, so a shutdown can stop taking new ones and wait for the rest. */
export class RequestTracker {
  activeCount = 0;
  isShuttingDown = false;

  startShutdown(): void {
    this.isShuttingDown = true;
    logger.info('Shutdown signal received, will reject new requests');
  }

  /** Wait for active requests to finish. False when `timeoutSeconds` ran out first. */
  async waitForDrain(timeoutSeconds = 30): Promise<boolean> {
    const deadline = performance.now() + timeoutSeconds * 1000;
    while (this.activeCount > 0) {
      if (performance.now() > deadline) {
        logger.warn(`Drain timeout after ${timeoutSeconds}s, ${this.activeCount} requests still active`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    logger.info('All active requests completed successfully');
    return true;
  }
}

/** During shutdown, every new request except the health checks gets a 503. A stream counts until its body ends. */
export function requestTracker(tracker: RequestTracker): MiddlewareHandler<Env> {
  return async (c, next) => {
    const path = c.req.path;
    if (tracker.isShuttingDown && path !== '/health' && path !== '/ready') {
      return c.text('Service shutting down', 503);
    }

    tracker.activeCount++;
    const done = () => {
      tracker.activeCount--;
    };
    try {
      await next();
    } catch (err) {
      done();
      throw err;
    }
    const streamDone = c.error ? undefined : c.get('streamDone');
    if (streamDone) void streamDone.finally(done);
    else done();
  };
}
