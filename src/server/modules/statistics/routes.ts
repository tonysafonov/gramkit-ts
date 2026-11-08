import { Hono } from 'hono';
import { adminUser } from '../../auth/rbac';
import type { Env } from '../../env';

/**
 * The Overview snapshot. The money analytics under `/analytics/*` belong to the analytics module, and no error mapping
 * is needed here: the service degrades instead of throwing (`error` on the overview).
 */
export const statisticsRoutes = new Hono<Env>()
  /** KPI snapshot for the admin Overview dashboard (current + prior windows). */
  .get('/statistics/overview', adminUser, async (c) => c.json(await c.var.services.statistics.getOverviewStatistics()));
