import { Hono } from 'hono';
import type { Env } from '../../env';

// Module load ≈ process start: a deploy that restarted this worker shows a new value.
const STARTED_AT = new Date().toISOString();

export const healthRoutes = new Hono<Env>()
  /** Liveness: 200 while the process is alive. Also says which build is live. */
  .get('/health', (c) =>
    c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: c.get('state').version,
      started_at: STARTED_AT,
    }),
  )
  /** Readiness: 200 in normal operation, 503 during shutdown so load balancers stop sending traffic here. */
  .get('/ready', (c) => {
    const { tracker } = c.get('state');
    if (tracker.isShuttingDown) return c.json({ status: 'shutting_down' }, 503);
    return c.json({ status: 'ready', active_requests: tracker.activeCount, timestamp: new Date().toISOString() });
  })
  .get('/ping', (c) => c.json({ pong: true }));
