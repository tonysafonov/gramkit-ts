import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { captureException } from '../clients/sentry';
import { AppError, type ValidationErrorItem } from './errors';
import { getLogger } from './logging';

const logger = getLogger('api');

const MALFORMED_JSON = 'Malformed JSON in request body';

const jsonInvalid = (c: Context) => {
  const item: ValidationErrorItem = { type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: {} };
  return c.json({ detail: [item] }, 422);
};

/** The global handler: renders `AppError`s, and logs anything else as a 500. Registered by `createApi`. */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) return c.json(err.toBody() as object, err.status, err.headers);
  if (err instanceof HTTPException) {
    return err.message === MALFORMED_JSON ? jsonInvalid(c) : c.json({ detail: err.message }, err.status);
  }
  logger.error({ err }, `Unhandled exception on ${c.req.method} ${c.req.path}: ${err.message}`);
  captureException(err);
  return c.json({ detail: err.message }, 500);
};
