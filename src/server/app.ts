/**
 * `createApi`: the fully configured Hono app, port of `core/infrastructure/fastapi/factory.py`.
 *
 *     const api = createApi({ reposClass: Repos, servicesClass: Services, routes, title: 'My API', version: '1.0.0' });
 *     await api.startup();
 *     // serve api.fetch
 *     await api.shutdown();
 *
 * Sets up the middleware stack, /health, the app's routes, static files, the error handler and the lifespan
 * (`startup` / `shutdown`). bench/conduit calls this same function with its own routes and classes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Context, type ErrorHandler, Hono } from 'hono';
import { syncOwnerRoles } from './auth/rbac';
import type { TelegramAuthenticator } from './auth/telegram';
import { type Clients, closeClients, getClients, posthog } from './clients';
import { initSentry } from './clients/sentry';
import { type DbConfig, settings, type WebConfig } from './config';
import { createDb, type DbClient } from './db/client';
import type { AppState, Env, ReposClass, ServicesClass } from './env';
import { errorHandler } from './lib/error-handler';
import { flushLogs, getLogger } from './lib/logging';
import {
  accessLog,
  cachedStatic,
  cors,
  RequestTracker,
  requestId,
  requestTracker,
  rootPathGetter,
  securityHeaders,
} from './middleware';
import { healthRoutes } from './modules/health/routes';
import { announceStart } from './modules/messages/admin-messages';

const logger = getLogger('api');

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'";

const DAY_SECONDS = 86400;
const YEAR_SECONDS = 365 * DAY_SECONDS;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type RoutingErrorRenderer = (
  c: Context,
  status: 404 | 405,
  message: string,
  headers?: Record<string, string>,
) => Response;

const detailRoutingError: RoutingErrorRenderer = (c, status, message, headers) =>
  c.json({ detail: message }, status, headers);

export interface CreateApiOptions<S, R> {
  reposClass: ReposClass<R>;
  /** The app's service aggregator: `getServices` builds one per request. */
  servicesClass: ServicesClass<S, R>;
  /** The app's routes, one chained router (`Hono<any>`: its `Env` is the app's own). */
  // biome-ignore lint/suspicious/noExplicitAny: an app's router is typed with its own Env, createApi only mounts it
  routes: Hono<any, any, any>;
  title?: string;
  version?: string;
  config?: WebConfig;
  dbConfig?: DbConfig;
  /** Directory served under /static. */
  staticPath?: string;
  /** Content Security Policy; strict by default. */
  securityCsp?: string;
  /** Prefix the proxy may leave on paths: "" for a subdomain, "/api/template" for path-based routing. */
  rootPath?: string;
  /** Async callbacks to run on startup, after the clients. */
  onStartup?: ((db: DbClient) => Promise<void>)[];
  /** Language of the shared guest when the request sends no X-App-Locale (`null`: the guest row's own). */
  guestLocale?: string | null;
  telegramAuth?: TelegramAuthenticator | null;
  /** Replace process clients: tests hand fakes. */
  clients?: Partial<Clients>;
  /** Replace the global error handler (Conduit's errors have their own shape). */
  errorHandler?: ErrorHandler;
  /** Render the router's own 404 and 405, whose answers an app may shape differently. */
  routingError?: RoutingErrorRenderer;
  /** Turn a webhook's signature check on. */
  yookassaWebhookSecret?: string;
  telegramWebhookSecret?: string;
}

export interface Api<S, R> {
  app: Hono<Env<S, R>>;
  state: AppState<S, R>;
  /** The request handler a server runs. */
  fetch: Hono['fetch'];
  /** The lifespan's startup half. Run it before serving. */
  startup(): Promise<void>;
  /** Stop taking requests, drain, close every client and the database. */
  shutdown(): Promise<void>;
}

/** The methods registered on `path`, not counting middleware. */
function allowedMethods<S, R>(app: Hono<Env<S, R>>, path: string): string[] {
  return METHODS.filter((method) => {
    const [handlers] = app.router.match(method, path);
    return handlers.some(([[, route]]) => (route as { method: string }).method !== 'ALL');
  });
}

/** Starlette's answers where Hono would give a plain 404: a 405 with `Allow`, and the redirect for a trailing slash. */
function notFoundHandler<S, R>(app: Hono<Env<S, R>>, render: RoutingErrorRenderer) {
  return (c: Context) => {
    const { path } = c.req;
    const allowed = allowedMethods(app, path);
    if (allowed.length > 0) return render(c, 405, 'Method Not Allowed', { Allow: allowed.join(', ') });

    const other = path.endsWith('/') ? path.slice(0, -1) : `${path}/`;
    if (other && allowedMethods(app, other).length > 0) {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : `${url.pathname}/`;
      return c.redirect(url.toString(), 307);
    }
    return render(c, 404, 'Not Found');
  };
}

export function createApi<S, R>(options: CreateApiOptions<S, R>): Api<S, R> {
  const {
    reposClass,
    servicesClass,
    routes,
    title = 'API',
    version = 'unknown',
    config = settings.web,
    dbConfig = settings.db,
    staticPath,
    securityCsp,
    rootPath = '',
    onStartup = [],
    guestLocale = null,
    telegramAuth = null,
    routingError = detailRoutingError,
    yookassaWebhookSecret,
    telegramWebhookSecret,
  } = options;

  initSentry(version);
  posthog.setup(settings.observability.posthogApiKey, settings.observability.posthogHost, version);

  const db = createDb(dbConfig);
  const tracker = new RequestTracker();
  const clients: Clients = { ...getClients(), ...options.clients };
  const state: AppState<S, R> = {
    title,
    version,
    config,
    db,
    clients,
    tracker,
    reposClass,
    servicesClass,
    telegramAuth,
    guestLocale,
    yookassaWebhookSecret,
    telegramWebhookSecret,
  };

  const app = new Hono<Env<S, R>>(rootPath ? { getPath: rootPathGetter(rootPath) } : {});

  // Order, outermost first, as Python's stack runs: (RootPath, in `getPath`) → CORS → Security → Tracker → RequestId
  // → AccessLog. The access log is innermost, so it runs inside the request context.
  app.use((c, next) => {
    c.set('state', state);
    return next();
  });
  app.use(
    cors({
      allowOrigins: [config.frontendUrl, ...config.corsOrigins],
      // In debug, any localhost origin, for direct frontend access
      allowOriginRegex: settings.debug ? /^http:\/\/localhost:\d+$/ : null,
    }),
  );
  app.use(securityHeaders({ csp: securityCsp ?? DEFAULT_CSP, hstsEnabled: !settings.debug }));
  app.use(requestTracker(tracker) as never);
  app.use(requestId as never);
  app.use(accessLog as never);

  app.route('/', healthRoutes as never);
  app.route('/', routes);

  if (staticPath && existsSync(staticPath)) {
    const imagesPath = join(staticPath, 'images');
    if (existsSync(imagesPath)) {
      app.get(
        '/static/images/*',
        cachedStatic({ root: imagesPath, prefix: '/static/images', cacheMaxAge: YEAR_SECONDS }),
      );
    }
    app.get('/static/*', cachedStatic({ root: staticPath, prefix: '/static', cacheMaxAge: DAY_SECONDS }));
  }

  app.notFound(notFoundHandler(app, routingError));
  app.onError(options.errorHandler ?? errorHandler);

  return {
    app,
    state,
    fetch: app.fetch,

    async startup() {
      logger.info('Application starting up');
      await syncOwnerRoles(db.db);
      for (const callback of onStartup) await callback(db);
      logger.info('Application ready');
      await announceStart('webhook', version, clients.bot);
    },

    async shutdown() {
      logger.info('Application shutting down');

      // 1. New requests get a 503, /health and /ready keep answering
      tracker.startShutdown();

      // 2. Wait for active requests to drain
      const drained = await tracker.waitForDrain(config.shutdownDrainTimeout);
      if (!drained) logger.warn(`${tracker.activeCount} requests still active after the drain timeout`);

      // 3. Close the process-wide clients, then the database
      await closeClients();
      await db.close();
      logger.info('Application shutdown complete');

      // 4. Write out the queued log lines
      flushLogs();
    },
  };
}
