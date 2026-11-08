import type { MiddlewareHandler } from 'hono';
import { withSentryScope } from '../clients/sentry';
import type { Env } from '../env';
import { generateRequestId, runWithRequestContext } from '../lib/request-context';

export const REQUEST_ID_HEADER = 'X-Request-ID';

/** Reads or generates X-Request-ID, opens the request context, echoes the id on the response. */
export const requestId: MiddlewareHandler<Env> = (c, next) => {
  const id = c.req.header(REQUEST_ID_HEADER) || generateRequestId();
  c.set('requestId', id);
  c.header(REQUEST_ID_HEADER, id);
  return withSentryScope(() =>
    runWithRequestContext({ requestId: id, path: c.req.path, method: c.req.method }, () => next()),
  );
};
