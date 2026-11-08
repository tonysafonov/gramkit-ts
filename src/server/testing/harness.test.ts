/** Proves the request path end to end: request → transaction → repo → commit, rollback, error shape, access log. */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getServices, getUser } from '../auth/context';
import { adminUser } from '../auth/rbac';
import { UserRole, users } from '../db/schema';
import type { Env } from '../env';
import { ConflictError } from '../lib/errors';
import { validate } from '../lib/validate';
import { asUser, captureLogs, createTestApp, createUser, type TestApp } from '.';

/** A pending request: resolves `reached` when the handler got there, then waits for `release`. */
function gate() {
  let reached = () => {};
  let release = () => {};
  return {
    reached: new Promise<void>((resolve) => {
      reached = resolve;
    }),
    waitForRelease: new Promise<void>((resolve) => {
      release = resolve;
    }),
    arrive: () => reached(),
    release: () => release(),
  };
}

let pending = gate();

const routes = new Hono<Env>()
  .post('/names', getServices, validate('json', z.object({ username: z.string().min(2) })), async (c) => {
    const user = await c.var.repos.users.create({ username: c.req.valid('json').username });
    return c.json({ id: user.id }, 201);
  })
  .post('/names/conflict', getServices, async (c) => {
    await c.var.repos.users.create({ username: 'rolled_back_conflict' });
    throw new ConflictError('Name is taken');
  })
  .post('/names/crash', getServices, async (c) => {
    await c.var.repos.users.create({ username: 'rolled_back_crash' });
    throw new Error('boom');
  })
  .post('/names/slow', getServices, async (c) => {
    await c.var.repos.users.create({ username: 'slow_commit' });
    pending.arrive();
    await pending.waitForRelease;
    return c.json({ ok: true });
  })
  .post('/hold', getServices, async (c) => {
    pending.arrive();
    await pending.waitForRelease;
    return c.json({ ok: true });
  })
  .get('/whoami', getUser, (c) => c.json({ id: c.var.user.id }))
  .get('/stacked', getServices, getUser, (c) =>
    c.json({ id: c.var.user.id, sameRepos: c.var.services.repos === c.var.repos }),
  )
  .get('/admin-only', adminUser, (c) => c.json({ ok: true }));

describe('the request path', () => {
  let t: TestApp;
  const logs = captureLogs();

  beforeAll(async () => {
    t = await createTestApp({ routes });
  });

  afterAll(async () => {
    logs.stop();
    await t.close();
  });

  afterEach(() => logs.clear());

  const rowsNamed = (username: string) => t.db.select().from(users).where(eq(users.username, username));

  describe('transaction', () => {
    it('commits what a repo wrote when the handler succeeds', async () => {
      const res = await t.client.post('/names', { username: 'committed' });

      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const rows = await rowsNamed('committed');
      expect(rows.map((row) => row.id)).toEqual([id]);
    });

    it('commits before the response, and not a moment earlier', async () => {
      pending = gate();
      const request = t.client.post('/names/slow');
      await pending.reached;

      // The row is written, in a transaction nobody else can see yet
      expect(await rowsNamed('slow_commit')).toEqual([]);

      pending.release();
      expect((await request).status).toBe(200);
      expect(await rowsNamed('slow_commit')).toHaveLength(1);
    });

    it('rolls back when the handler throws an AppError', async () => {
      const res = await t.client.post('/names/conflict');

      expect(res.status).toBe(409);
      expect(await rowsNamed('rolled_back_conflict')).toEqual([]);
    });

    it('rolls back when the handler throws anything else', async () => {
      const res = await t.client.post('/names/crash');

      expect(res.status).toBe(500);
      expect(await rowsNamed('rolled_back_crash')).toEqual([]);
    });

    it('holds no connection while the body is still arriving', async () => {
      const { sql } = t.api.state.db;
      const encoder = new TextEncoder();
      let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upload = controller;
        },
      });
      const request = t.client.request('/names', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '22' },
        body,
        duplex: 'half',
      } as RequestInit);

      upload?.enqueue(encoder.encode('{"username":'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sql.stats.leased).toBe(0);

      upload?.enqueue(encoder.encode('"uploaded"}'));
      upload?.close();
      expect((await request).status).toBe(201);
      expect(await rowsNamed('uploaded')).toHaveLength(1);
    });

    it('answers a 503 in auth when the pool stays full past the timeout', async () => {
      const { sql } = t.api.state.db;
      const { options } = sql;
      const timeout = options.queue_timeout;
      options.queue_timeout = 0.05;
      pending = gate();
      const holders = Array.from({ length: options.max }, () => t.client.post('/hold'));
      await vi.waitFor(() => expect(sql.stats.leased).toBe(options.max));

      const res = await t.client.get('/whoami');

      options.queue_timeout = timeout;
      pending.release();
      await Promise.all(holders);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    });

    it('opens one transaction when middlewares stack', async () => {
      const user = await createUser(t.db);

      const res = await t.client.get('/stacked', { headers: asUser(user) });

      expect(await res.json()).toEqual({ id: user.id, sameRepos: true });
    });
  });

  describe('error shape', () => {
    it('renders an AppError as {detail}', async () => {
      const res = await t.client.post('/names/conflict');

      expect(await res.json()).toEqual({ detail: 'Name is taken' });
    });

    it('renders an unhandled error as a 500 {detail} and logs it', async () => {
      const res = await t.client.post('/names/crash');

      expect(await res.json()).toEqual({ detail: 'boom' });
      expect(logs.lines.some((line) => line.msg === 'Unhandled exception on POST /names/crash: boom')).toBe(true);
    });

    it('renders a body validation error as FastAPI 422', async () => {
      const res = await t.client.post('/names', { username: 'x' });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: { loc: unknown[]; msg: string; type: string }[] };
      expect(body.detail).toHaveLength(1);
      expect(body.detail[0]?.loc).toEqual(['body', 'username']);
      expect(body.detail[0]?.type).toBe('too_small');
    });

    it('says a required field is missing as FastAPI does', async () => {
      const res = await t.client.post('/names', {});

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        detail: [{ type: 'missing', loc: ['body', 'username'], msg: 'Field required', input: {} }],
      });
    });

    it('answers a malformed JSON body with a 422', async () => {
      const res = await t.client.request('/names', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: { type: string }[] };
      expect(body.detail[0]?.type).toBe('json_invalid');
    });

    it('answers an unknown path with {detail: Not Found}', async () => {
      const res = await t.client.get('/nothing-here');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Not Found' });
    });

    it('answers a known path with the wrong method with a 405 and Allow', async () => {
      const res = await t.client.delete('/whoami');

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
      expect(await res.json()).toEqual({ detail: 'Method Not Allowed' });
    });
  });

  describe('access log', () => {
    it('writes exactly one INFO line per request, with the request id and user', async () => {
      const user = await createUser(t.db);

      const res = await t.client.get('/whoami?q=secret', { headers: asUser(user) });

      const lines = logs.accessLines();
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line?.msg).toMatch(/^GET \/whoami 200 \d+ms$/);
      expect(line?.req).toBe(res.headers.get('x-request-id'));
      expect(line?.user).toBe(user.id);
    });

    it('logs failures too', async () => {
      await t.client.post('/names/conflict');
      await t.client.post('/names/crash');
      await t.client.get('/nothing-here');

      expect(logs.accessLines().map((line) => line.msg.replace(/ \d+ms$/, ''))).toEqual([
        'POST /names/conflict 409',
        'POST /names/crash 500',
        'GET /nothing-here 404',
      ]);
    });
  });

  describe('typed client', () => {
    it('calls a route through hc with its types', async () => {
      const user = await createUser(t.db);

      const res = await t.typed<typeof routes>().whoami.$get(undefined, { headers: asUser(user) });

      expect((await res.json()).id).toBe(user.id);
    });
  });

  describe('rbac', () => {
    it('forbids a plain user', async () => {
      const user = await createUser(t.db);

      const res = await t.client.get('/admin-only', { headers: asUser(user) });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: "Requires role: ['admin', 'owner']" });
    });

    it('lets an admin through', async () => {
      const user = await createUser(t.db, { role: UserRole.ADMIN });

      const res = await t.client.get('/admin-only', { headers: asUser(user) });

      expect(res.status).toBe(200);
    });

    it('lets a configured owner through whatever the row says', async () => {
      const user = await createUser(t.db, { telegramId: 123456789 });

      const res = await t.client.get('/admin-only', { headers: asUser(user) });

      expect(res.status).toBe(200);
    });
  });
});
