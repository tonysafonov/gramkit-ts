import { Hono } from 'hono';
import type { Env } from './env';
import { adminRoutes } from './modules/admin/routes';
import { adminTasksRoutes } from './modules/admin-tasks/routes';
import { analyticsRoutes } from './modules/analytics/routes';
import { auditLogRoutes } from './modules/audit-log/routes';
import { authRoutes } from './modules/auth/routes';
import { broadcastsRoutes } from './modules/broadcasts/routes';
import { demoRoutes } from './modules/demo/routes';
import { invitesRoutes } from './modules/invites/routes';
import { marketingLinksRoutes } from './modules/marketing-links/routes';
import { paymentsRoutes } from './modules/payments/routes';
import { startRoutes } from './modules/start/routes';
import { statisticsRoutes } from './modules/statistics/routes';
import { subscriptionsRoutes } from './modules/subscriptions/routes';
import { telegramLinkRoutes } from './modules/telegram-link/routes';
import { friendsRoutes, usersRoutes } from './modules/users/routes';
import { telegramStarsRoutes, yookassaRoutes } from './modules/webhooks/routes';

/**
 * Every API route, in Python's mount order. Module routers hold paths relative to the prefix here, except
 * `subscriptionsRoutes`: `GET /subscriptions/` keeps its trailing slash, which a mounted `/` would lose, so that
 * router holds full paths.
 */
export const routes = new Hono<Env>()
  .route('/auth', authRoutes)
  .route('/auth/link/telegram', telegramLinkRoutes)
  .route('/payments', paymentsRoutes)
  .route('/', subscriptionsRoutes)
  .route('/users', usersRoutes)
  .route('/yookassa', yookassaRoutes)
  .route('/telegram-stars', telegramStarsRoutes)
  // Python's `routers.base`: no prefix
  .route('/', friendsRoutes)
  .route('/', invitesRoutes)
  .route('/', startRoutes)
  // Python's core admin router and the routers it includes, all under /admin
  .route('/admin', adminRoutes)
  .route('/admin', auditLogRoutes)
  .route('/admin', adminTasksRoutes)
  .route('/admin', broadcastsRoutes)
  .route('/admin', marketingLinksRoutes)
  .route('/admin', statisticsRoutes)
  .route('/admin', analyticsRoutes)
  .route('/demo', demoRoutes);

/** For `hc<AppType>`: the typed client. */
export type AppType = typeof routes;
