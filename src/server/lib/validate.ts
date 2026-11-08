/**
 * Request validation with FastAPI's error: a 422 with `{"detail": [{"type", "loc", "msg", "input"}]}`.
 *
 *     .post('/x', getUser, validate('json', BodySchema), (c) => { const body = c.req.valid('json'); ... })
 *
 * Put it after `getUser`: FastAPI resolves dependencies first, so a bad token beats a bad body. The failure is thrown,
 * not returned, so the request's transaction rolls back like any other error.
 */
import { zValidator } from '@hono/zod-validator';
import type { Context, ValidationTargets } from 'hono';
import type { core, ZodType } from 'zod';
import { RequestValidationError, type ValidationErrorItem } from './errors';

/** Hono's validator reads a body as JSON only under this content type. */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

const LOCATIONS: Record<keyof ValidationTargets, string> = {
  json: 'body',
  form: 'body',
  query: 'query',
  param: 'path',
  header: 'header',
  cookie: 'cookie',
};

function isMissing(issue: core.$ZodIssue, input: unknown): boolean {
  if (issue.code !== 'invalid_type') return false;
  let value = input;
  for (const key of issue.path) {
    if (value === null || typeof value !== 'object') return true;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value === undefined;
}

function toErrorItem(issue: core.$ZodIssue, target: keyof ValidationTargets, input: unknown): ValidationErrorItem {
  const loc = [LOCATIONS[target], ...issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part))];
  if (isMissing(issue, input)) return { type: 'missing', loc, msg: 'Field required', input };
  return { type: issue.code, loc, msg: issue.message, input };
}

/**
 * FastAPI's reading of a required JSON body. Hono's validator takes both of these for `{}`, which passes a schema with
 * only optional fields: an empty body is a missing body, and a body that isn't declared as JSON stays bytes.
 */
async function assertJsonBody(c: Context): Promise<void> {
  const body = await c.req.text();
  if (!body) throw new RequestValidationError([{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }]);
  if (!JSON_CONTENT_TYPE.test(c.req.header('Content-Type') ?? '')) {
    throw new RequestValidationError([
      {
        type: 'model_attributes_type',
        loc: ['body'],
        msg: 'Input should be a valid dictionary or object to extract fields from',
        input: body,
      },
    ]);
  }
}

export const validate = <Target extends keyof ValidationTargets, Schema extends ZodType>(
  target: Target,
  schema: Schema,
) => {
  const validator = zValidator(target, schema, (result) => {
    if (!result.success) {
      const input = result.data;
      throw new RequestValidationError(result.error.issues.map((issue) => toErrorItem(issue, target, input)));
    }
  });
  if (target !== 'json') return validator;
  return (async (c, next) => {
    await assertJsonBody(c);
    return validator(c, next);
  }) as typeof validator;
};
