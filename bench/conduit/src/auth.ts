/**
 * Conduit auth: `Authorization: Token <jwt>` (HS256, `sub` = user id), verified on every request. Python's
 * `webhook/auth.py`.
 *
 * The app's counterpart of the framework's `getUser`, used only by Conduit's own routes: a middleware that every
 * endpoint takes, logs the user at DEBUG and sets the Sentry and log user, as the framework does per request.
 */
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { setSentryUser } from '../../../src/server/clients/sentry';
import type { ServicesEnv } from '../../../src/server/env';
import { getLogger } from '../../../src/server/lib/logging';
import { JWT_SECRET } from './env';
import { UnauthorizedError } from './errors';
import type { ConduitRepos } from './repos';
import type { ConduitServices } from './services';

const logger = getLogger('conduit.auth');

const INT64_MAX = 2n ** 63n - 1n;
const DIGITS = /^[0-9]+$/;

export interface Viewer {
  /** 0 = anonymous. */
  userId: number;
  token: string;
}

export interface Page {
  limit: number;
  offset: number;
}

const ANONYMOUS: Viewer = { userId: 0, token: '' };

type BaseEnv = ServicesEnv<ConduitServices, ConduitRepos>;

export type ConduitEnv = { Variables: BaseEnv['Variables'] & { viewer: Viewer; page: Page } };

/**
 * ASCII digits only (no sign, spaces or '_'), fitting a bigint; else `null`. Past 2^53 a JS number can't hold the
 * value, and no id or offset gets there: those are clamped, and find nothing, as the exact value would.
 */
export function parseUint(s: string): number | null {
  if (!DIGITS.test(s)) return null;
  const n = Number(s);
  if (n <= Number.MAX_SAFE_INTEGER) return n;
  return BigInt(s) <= INT64_MAX ? Number.MAX_SAFE_INTEGER : null;
}

async function parseAuthorization(header: string): Promise<Viewer> {
  if (!header.startsWith('Token ')) throw new UnauthorizedError('invalid authorization header');
  const token = header.slice(6);
  let claims: Awaited<ReturnType<typeof verify>>;
  try {
    claims = await verify(token, JWT_SECRET, { alg: 'HS256', iat: false });
  } catch {
    throw new UnauthorizedError('invalid or expired token');
  }
  if (claims.exp === undefined) throw new UnauthorizedError('invalid or expired token');
  const userId = typeof claims.sub === 'string' ? parseUint(claims.sub) : null;
  if (!userId) throw new UnauthorizedError('invalid token subject');
  logger.debug(`Conduit user ${userId} authenticated`); // as the framework's getUser: the access-log line carries the user
  setSentryUser({ userId: String(userId) });
  return { userId, token };
}

export const authRequired: MiddlewareHandler<ConduitEnv> = createMiddleware<ConduitEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  if (!header) throw new UnauthorizedError('authorization required');
  c.set('viewer', await parseAuthorization(header));
  await next();
});

export const authOptional: MiddlewareHandler<ConduitEnv> = createMiddleware<ConduitEnv>(async (c, next) => {
  const header = c.req.header('authorization'); // an empty header counts as absent
  c.set('viewer', header ? await parseAuthorization(header) : ANONYMOUS);
  await next();
});
