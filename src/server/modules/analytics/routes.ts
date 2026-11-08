/**
 * Core admin routes: the money analytics. Mounted under `/admin`; these are the `/admin/analytics/*` routes of
 * Python's `admin_statistics` router (the Overview snapshot is `statisticsRoutes`).
 */
import { Hono } from 'hono';
import { adminUser } from '../../auth/rbac';
import type { UserEnv } from '../../env';
import { validate } from '../../lib/validate';
import {
  RevenueTimeseriesQuery,
  SubscriptionTrendQuery,
  toMrrResponse,
  toRevenueKpisResponse,
  toRevenueTimeseriesResponse,
  toSubscriptionBreakdownResponse,
  toSubscriptionTrendResponse,
} from './schemas';

export const analyticsRoutes = new Hono<UserEnv>()
  .get('/analytics/revenue-timeseries', adminUser, validate('query', RevenueTimeseriesQuery), async (c) => {
    const { granularity, days } = c.req.valid('query');
    return c.json(toRevenueTimeseriesResponse(await c.var.services.analytics.revenueTimeseries({ granularity, days })));
  })
  .get('/analytics/revenue-kpis', adminUser, async (c) =>
    c.json(toRevenueKpisResponse(await c.var.services.analytics.revenueKpis())),
  )
  .get('/analytics/subscription-trend', adminUser, validate('query', SubscriptionTrendQuery), async (c) => {
    const { weeks } = c.req.valid('query');
    return c.json(toSubscriptionTrendResponse(await c.var.services.analytics.subscriptionTrend({ weeks })));
  })
  .get('/analytics/subscription-breakdown', adminUser, async (c) =>
    c.json(toSubscriptionBreakdownResponse(await c.var.services.analytics.subscriptionBreakdown())),
  )
  .get('/analytics/mrr', adminUser, async (c) => c.json(toMrrResponse(await c.var.services.analytics.mrr())));
