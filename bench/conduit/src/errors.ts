/**
 * Every error as `{"errors": {"body": [<message>]}}` (SPEC.md "Formats"): Python's `exceptions.py` and
 * `webhook/errors.py`.
 *
 * Unlike the template (routes translate errors), the spec needs one shape for every status, so the domain errors get
 * their own handler. Router-level 404/405 and validation 422 get the same shape. Anything else goes on to the
 * framework's handler: logged, sent to Sentry, a 500.
 */
import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { RoutingErrorRenderer } from '../../../src/server/app';
import { errorHandler } from '../../../src/server/lib/error-handler';
import { RequestValidationError } from '../../../src/server/lib/errors';

const MALFORMED_JSON = 'Malformed JSON in request body';

/** Base for this app's domain errors. Services throw them, so the request's transaction rolls back. */
export class ConduitError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends ConduitError {
  constructor(message: string) {
    super(401, message);
  }
}

export class ForbiddenError extends ConduitError {
  constructor(message: string) {
    super(403, message);
  }
}

export class NotFoundError extends ConduitError {
  constructor(message: string) {
    super(404, message);
  }
}

export class UnprocessableError extends ConduitError {
  constructor(message: string) {
    super(422, message);
  }
}

const errorResponse = (c: Context, status: ContentfulStatusCode, message: string, headers?: Record<string, string>) =>
  c.json({ errors: { body: [message] } }, status, headers);

export const conduitErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ConduitError) return errorResponse(c, err.status, err.message);
  if (err instanceof RequestValidationError) {
    const first = err.errors[0];
    const where = first?.loc.slice(1).join('.') || first?.loc[0];
    return errorResponse(c, 422, `${where}: ${first?.msg}`);
  }
  if (err instanceof HTTPException) {
    return err.message === MALFORMED_JSON
      ? errorResponse(c, 422, 'body: JSON decode error')
      : errorResponse(c, err.status, err.message.toLowerCase());
  }
  return errorHandler(err, c);
};

/** Router-level 404 and 405: `createApi` decides which, this gives them the spec's shape. */
export const conduitRoutingError: RoutingErrorRenderer = (c, status, message, headers) =>
  errorResponse(c, status, message.toLowerCase(), headers);
