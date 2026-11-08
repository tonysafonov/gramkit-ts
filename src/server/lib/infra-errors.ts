/**
 * Is this error the infrastructure failing (DB, Redis, network), not the request or our code?
 *
 * The answer decides the HTTP status: an infrastructure failure is a 503 the client retries, never a 401 ("not logged
 * in") or a guest fallback. Under load, DNS failures or a restarting Postgres surface while opening the first
 * connection of a request, which for most requests is the auth lookup.
 *
 * What counts:
 * - Postgres server errors of class 08 (connection), 53 (out of resources), 57 (operator intervention);
 * - postgres.js' own connection errors (`CONNECTION_CLOSED`, `CONNECT_TIMEOUT`, ...) and a full pool (`QUEUE_TIMEOUT`);
 * - ioredis' connection errors (`Connection is closed.`, `MaxRetriesPerRequestError`);
 * - Node system errors from sockets (`ECONNREFUSED`, `EAI_AGAIN`, ...) and timeouts, but not filesystem errors.
 *
 * The `cause` chain is walked: Drizzle wraps every driver error in a `DrizzleQueryError`.
 */

const CONNECTION_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'QUEUE_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENOTCONN',
  'ESOCKETTIMEDOUT',
]);

const SQLSTATE_CLASSES = new Set(['08', '53', '57']);

const INFRA_ERROR_NAMES = new Set(['MaxRetriesPerRequestError', 'ClusterAllFailedError', 'TimeoutError']);

const REDIS_CONNECTION_MESSAGES = new Set([
  'Connection is closed.',
  "Stream isn't writeable and enableOfflineQueue options is false",
]);

const MAX_CHAIN = 8;

interface ErrorLike {
  name?: string;
  code?: unknown;
  message?: string;
  cause?: unknown;
}

function isInfra(err: ErrorLike): boolean {
  if (typeof err.code === 'string') {
    if (CONNECTION_CODES.has(err.code)) return true;
    // A SQLSTATE is five characters; system error codes never match this.
    if (err.code.length === 5 && SQLSTATE_CLASSES.has(err.code.slice(0, 2))) return true;
  }
  if (err.name && INFRA_ERROR_NAMES.has(err.name)) return true;
  return err.message !== undefined && REDIS_CONNECTION_MESSAGES.has(err.message);
}

/** True when `error` (or what it wraps) is the DB, Redis or the network failing: answer 503, not 4xx. */
export function isInfrastructureError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && seen.size < MAX_CHAIN) {
    if (isInfra(current as ErrorLike)) return true;
    seen.add(current);
    current = (current as ErrorLike).cause;
  }
  return false;
}
