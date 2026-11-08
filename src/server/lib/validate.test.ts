/** A required JSON body read the way FastAPI reads it. Compared against a running FastAPI app, not guessed. */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error-handler';
import { validate } from './validate';

const app = new Hono()
  .post('/optional', validate('json', z.object({ delay: z.number().default(5) })), (c) => c.json(c.req.valid('json')))
  .post('/required', validate('json', z.object({ name: z.string() })), (c) => c.json(c.req.valid('json')));
app.onError(errorHandler);

const post = (path: string, body?: string, contentType?: string) =>
  app.request(path, { method: 'POST', body, headers: contentType ? { 'content-type': contentType } : {} });

describe('validate json', () => {
  it('passes a JSON body, and fills in the defaults of `{}`', async () => {
    expect(await (await post('/optional', '{"delay":1}', 'application/json')).json()).toEqual({ delay: 1 });
    expect(await (await post('/optional', '{}', 'application/json; charset=utf-8')).json()).toEqual({ delay: 5 });
    expect((await post('/required', '{"name":"a"}', 'application/vnd.api+json')).status).toBe(200);
  });

  it.each([
    ['no content type', undefined],
    ['JSON content type', 'application/json'],
  ])('a missing body is a 422 at `body`, even with no required field: %s', async (_, contentType) => {
    const res = await post('/optional', undefined, contentType);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: [{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }],
    });
  });

  it.each([
    ['no content type', undefined],
    ['another content type', 'text/plain'],
  ])('a body not declared as JSON is not read as JSON: %s', async (_, contentType) => {
    const res = await post('/optional', '{"delay":1}', contentType);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: [
        {
          type: 'model_attributes_type',
          loc: ['body'],
          msg: 'Input should be a valid dictionary or object to extract fields from',
          input: '{"delay":1}',
        },
      ],
    });
  });

  it('a missing field is a 422 at the field', async () => {
    const res = await post('/required', '{}', 'application/json');

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: [{ type: 'missing', loc: ['body', 'name'] }] });
  });

  it('malformed JSON is a json_invalid 422', async () => {
    const res = await post('/required', '{oops', 'application/json');

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: [{ type: 'json_invalid', loc: ['body'] }] });
  });
});
