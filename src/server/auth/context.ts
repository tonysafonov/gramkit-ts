/**
 * The request dependencies every route uses: Python's `get_services` and `get_user` as Hono middleware.
 *
 *     new Hono<Env>()
 *       .get('/me', getUser, (c) => c.json(toUserResponse(c.var.user)))
 *       .post('/x', getUser, validate('json', Body), (c) => { const { services } = c.var; ... })
 *
 * The app configures them through `createApi` (`reposClass`, `servicesClass`, `telegramAuth`, `guestLocale`), so an
 * app (bench/conduit too) chains these same middlewares against its own classes: see `typedContext`.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ServicesEnv, UserEnv } from '../env';
import { ServiceUnavailableError } from '../lib/errors';
import { isInfrastructureError } from '../lib/infra-errors';
import { getLogger } from '../lib/logging';
import { withTransaction } from '../middleware/transaction';

const logger = getLogger('auth');

/** The 503 for an infrastructure failure during auth (`Retry-After` set; the cause goes to the log). */
export function serviceUnavailable(error: unknown): ServiceUnavailableError {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({ err }, `Infrastructure error during authentication: ${err.name}: ${err.message}`);
  return new ServiceUnavailableError();
}

function attachServices<E extends ServicesEnv>(context: Context<E>): void {
  const c = context as unknown as Context<ServicesEnv>;
  if (c.get('services')) return;
  const { servicesClass, clients } = c.get('state');
  c.set('services', new servicesClass(c.get('repos'), clients.producer, clients.bot, clients.redis, clients.queue));
}

/** The app's service aggregator for this request, on its transaction. */
export const getServices = createMiddleware<ServicesEnv>((c, next) =>
  withTransaction(c, async () => {
    attachServices(c);
    await next();
  }),
);

/**
 * The request's user: `getServices` plus `services.auth.resolveUser` (Telegram initData, the session cookie, or the
 * shared guest). Never a 401 for "not logged in": gate routes with `auth/rbac`.
 *
 * Opening the transaction is the first thing that touches the database, so a failure there is an infrastructure
 * failure during auth: a 503, as a failing lookup in `resolveUser` is. Python gets this for free, its first query
 * opens the connection inside `resolve_user`.
 */
export const getUser = createMiddleware<UserEnv>(async (c, next) => {
  let began = false;
  try {
    await withTransaction(c, async () => {
      began = true;
      attachServices(c);
      if (!c.get('user')) c.set('user', await c.get('services').auth.resolveUser(c));
      await next();
    });
  } catch (err) {
    if (!began && isInfrastructureError(err)) throw serviceUnavailable(err);
    throw err;
  }
});

/** The user's id, `null` for no user. */
export const getCurrentUserId = (c: Context<UserEnv>): string | null => c.get('user')?.id ?? null;

/**
 * `getServices`, `getUser` typed for an app with its own aggregators. The middleware is the same: it builds whatever
 * `createApi` was given. `getUser` still needs `services.auth.resolveUser` on the app's class.
 */
export const typedContext = <S, R = unknown>() => ({
  getServices: getServices as unknown as MiddlewareHandler<ServicesEnv<S, R>>,
  getUser: getUser as unknown as MiddlewareHandler<UserEnv<S, R>>,
});
