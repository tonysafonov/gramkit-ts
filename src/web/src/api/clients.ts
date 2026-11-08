/**
 * The typed API clients: Hono's `hc`, one per route group, so a call's type is inferred from that group's router
 * alone (one client over the whole app would make every call pay for every route). Types come from the server's
 * routes: there is no codegen step. Import the router types only (`import type`), never server code.
 *
 * The prefixes mirror `src/server/routes.ts`. `subscriptionsApi` holds full paths, like its router.
 */
import { hc } from 'hono/client';
import { API_BASE_URL, apiClientFetch } from '@core/api';
import type { adminRoutes } from '@server/modules/admin/routes';
import type { adminTasksRoutes } from '@server/modules/admin-tasks/routes';
import type { analyticsRoutes } from '@server/modules/analytics/routes';
import type { auditLogRoutes } from '@server/modules/audit-log/routes';
import type { authRoutes } from '@server/modules/auth/routes';
import type { broadcastsRoutes } from '@server/modules/broadcasts/routes';
import type { demoRoutes } from '@server/modules/demo/routes';
import type { invitesRoutes } from '@server/modules/invites/routes';
import type { marketingLinksRoutes } from '@server/modules/marketing-links/routes';
import type { startRoutes } from '@server/modules/start/routes';
import type { statisticsRoutes } from '@server/modules/statistics/routes';
import type { subscriptionsRoutes } from '@server/modules/subscriptions/routes';
import type { telegramLinkRoutes } from '@server/modules/telegram-link/routes';
import type { friendsRoutes, usersRoutes } from '@server/modules/users/routes';

const options = { fetch: apiClientFetch };

export const authApi = hc<typeof authRoutes>(`${API_BASE_URL}/auth`, options);
export const telegramLinkApi = hc<typeof telegramLinkRoutes>(`${API_BASE_URL}/auth/link/telegram`, options);
export const usersApi = hc<typeof usersRoutes>(`${API_BASE_URL}/users`, options);
export const friendsApi = hc<typeof friendsRoutes>(API_BASE_URL, options);
export const invitesApi = hc<typeof invitesRoutes>(API_BASE_URL, options);
export const startApi = hc<typeof startRoutes>(API_BASE_URL, options);
export const subscriptionsApi = hc<typeof subscriptionsRoutes>(API_BASE_URL, options);
export const demoApi = hc<typeof demoRoutes>(`${API_BASE_URL}/demo`, options);

// The admin routers all mount at /admin.
export const adminApi = hc<typeof adminRoutes>(`${API_BASE_URL}/admin`, options);
export const auditLogApi = hc<typeof auditLogRoutes>(`${API_BASE_URL}/admin`, options);
export const adminTasksApi = hc<typeof adminTasksRoutes>(`${API_BASE_URL}/admin`, options);
export const broadcastsApi = hc<typeof broadcastsRoutes>(`${API_BASE_URL}/admin`, options);
export const marketingLinksApi = hc<typeof marketingLinksRoutes>(`${API_BASE_URL}/admin`, options);
export const statisticsApi = hc<typeof statisticsRoutes>(`${API_BASE_URL}/admin`, options);
export const analyticsApi = hc<typeof analyticsRoutes>(`${API_BASE_URL}/admin`, options);
