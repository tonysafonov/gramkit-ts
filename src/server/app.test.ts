/** The middleware stack and `createApi`'s own behaviour, through real requests. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from './app';
import { getUser, typedContext } from './auth/context';
import { settings } from './config';
import type { Env } from './env';
import { trackStream } from './lib/streaming';
import { HARD_LIMIT, rateLimit } from './middleware';
import { Repos } from './repos';
import {
  asUser,
  captureLogs,
  createTestApp,
  createUser,
  FakeBot,
  FakeProducer,
  FakeQueue,
  FakeRedis,
  type TestApp,
  TestClient,
  TestServices,
} from './testing';

const routes = new Hono<Env>()
  .get('/items/', (c) => c.json({ ok: true }))
  .get('/open', (c) => c.json({ ok: true }))
  .get('/needs-user', getUser, (c) => c.json({ ok: true }))
  .get('/limited', getUser, rateLimit('2/minute'), (c) => c.json({ ok: true }))
  .get('/limited-hard', getUser, rateLimit(HARD_LIMIT), (c) => c.json({ ok: true }))
  .get('/stream', (c) => {
    const end = trackStream(c);
    return streamText(c, async (stream) => {
      await stream.write('a');
      await stream.sleep(20);
      await stream.write('b');
      end();
    });
  })
  .get('/stream-failed', (c) => {
    trackStream(c);
    throw new Error('no stream after all');
  });

describe('createApi', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ routes });
  });

  afterAll(() => t.close());

  describe('health', () => {
    it('answers /health with the build', async () => {
      const res = await t.client.get('/health');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'healthy', version: 'test' });
    });

    it('answers /ping and /ready', async () => {
      expect(await (await t.client.get('/ping')).json()).toEqual({ pong: true });
      expect(await (await t.client.get('/ready')).json()).toMatchObject({ status: 'ready' });
    });
  });

  describe('headers', () => {
    it('sets the security headers, in error responses too', async () => {
      for (const res of [await t.client.get('/open'), await t.client.get('/nothing')]) {
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-xss-protection')).toBe('1; mode=block');
        expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      }
    });

    it('sends no HSTS in debug', async () => {
      expect((await t.client.get('/open')).headers.get('strict-transport-security')).toBeNull();
    });

    it('generates a request id, and echoes one it was given', async () => {
      const generated = await t.client.get('/open');
      expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

      const given = await t.client.get('/open', { headers: { 'x-request-id': 'abc' } });
      expect(given.headers.get('x-request-id')).toBe('abc');
    });
  });

  describe('cors', () => {
    const origin = 'https://elsewhere.example';

    it('allows the frontend origin and, in debug, any localhost', async () => {
      for (const allowed of [settings.web.frontendUrl, 'http://localhost:9999']) {
        const res = await t.client.get('/open', { headers: { origin: allowed } });
        expect(res.headers.get('access-control-allow-origin')).toBe(allowed);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
        expect(res.headers.get('vary')).toContain('Origin');
      }
    });

    it('does not allow another origin', async () => {
      const res = await t.client.get('/open', { headers: { origin } });

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('answers a preflight itself', async () => {
      const res = await t.client.request('/open', {
        method: 'OPTIONS',
        headers: {
          origin: settings.web.frontendUrl,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-custom',
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('OK');
      expect(res.headers.get('access-control-allow-headers')).toBe('x-custom');
    });

    it('answers a preflight outside the rest of the stack: no security headers, no request id, no access line', async () => {
      const logs = captureLogs();
      const res = await t.client.request('/open', {
        method: 'OPTIONS',
        headers: { origin: settings.web.frontendUrl, 'access-control-request-method': 'GET' },
      });
      logs.stop();

      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('x-request-id')).toBeNull();
      expect(logs.accessLines()).toHaveLength(0);
    });

    it('refuses a preflight from another origin', async () => {
      const res = await t.client.request('/open', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Disallowed CORS origin');
    });
  });

  describe('routing', () => {
    it('redirects a missing trailing slash, as Starlette does', async () => {
      const res = await t.client.get('/items?x=1');

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/items/?x=1');
    });

    it('redirects an extra trailing slash', async () => {
      const res = await t.client.get('/open/');

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/open');
    });
  });

  describe('rate limit', () => {
    it("answers past the limit with slowapi's 429", async () => {
      const user = await createUser(t.db);
      const get = () => t.client.get('/limited', { headers: asUser(user) });

      expect((await get()).status).toBe(200);
      expect((await get()).status).toBe(200);
      const res = await get();

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Rate limit exceeded: 2 per 1 minute' });
    });

    it('counts per user', async () => {
      const [first, second] = [await createUser(t.db), await createUser(t.db)];

      for (let i = 0; i < 3; i++) await t.client.get('/limited', { headers: asUser(first) });

      expect((await t.client.get('/limited', { headers: asUser(second) })).status).toBe(200);
    });

    it('lets requests through when Redis fails', async () => {
      const user = await createUser(t.db);
      const { redis } = t.api.state.clients;
      const incr = redis.incr;
      redis.incr = () => Promise.reject(new Error('Connection is closed.'));

      const res = await t.client.get('/limited-hard', { headers: asUser(user) });

      redis.incr = incr;
      expect(res.status).toBe(200);
    });
  });

  describe('streaming', () => {
    it('logs a stream and counts it active until the body ends', async () => {
      const logs = captureLogs();
      const res = await t.client.get('/stream');

      expect(t.api.state.tracker.activeCount).toBe(1);
      expect(logs.accessLines()).toHaveLength(0);

      expect(await res.text()).toBe('ab');
      await new Promise((resolve) => setTimeout(resolve, 0));
      logs.stop();

      expect(t.api.state.tracker.activeCount).toBe(0);
      expect(logs.accessLines().map((line) => line.msg.replace(/ \d+ms$/, ''))).toEqual(['GET /stream 200']);
    });

    it('does not wait for a stream the handler failed before starting', async () => {
      const logs = captureLogs();
      const res = await t.client.get('/stream-failed');
      logs.stop();

      expect(res.status).toBe(500);
      expect(t.api.state.tracker.activeCount).toBe(0);
      expect(logs.accessLines().map((line) => line.msg.replace(/ \d+ms$/, ''))).toEqual(['GET /stream-failed 500']);
    });
  });
});

describe('root path', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ routes, rootPath: '/api/template' });
  });

  afterAll(() => t.close());

  it('routes with or without the proxy prefix', async () => {
    expect((await t.client.get('/api/template/open')).status).toBe(200);
    expect((await t.client.get('/open')).status).toBe(200);
  });

  it('logs the stripped path', async () => {
    const logs = captureLogs();
    await t.client.get('/api/template/open');
    logs.stop();

    expect(logs.accessLines()[0]?.msg).toMatch(/^GET \/open 200/);
  });
});

describe('static files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gramkit-static-'));
  let t: TestApp;

  beforeAll(async () => {
    mkdirSync(join(dir, 'images'));
    writeFileSync(join(dir, 'hello.txt'), 'hello');
    writeFileSync(join(dir, 'images', 'dot.png'), 'png');
    t = await createTestApp({ routes, staticPath: dir });
  });

  afterAll(() => t.close());

  it('serves a file with a day of cache', async () => {
    const res = await t.client.get('/static/hello.txt');

    expect(await res.text()).toBe('hello');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('serves images with a year of cache', async () => {
    const res = await t.client.get('/static/images/dot.png');

    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers a matching etag with a 304', async () => {
    const etag = (await t.client.get('/static/hello.txt')).headers.get('etag') ?? '';

    const res = await t.client.get('/static/hello.txt', { headers: { 'if-none-match': etag } });

    expect(res.status).toBe(304);
  });

  it('answers a missing file and a traversal with a 404', async () => {
    expect((await t.client.get('/static/nope.txt')).status).toBe(404);
    expect((await t.client.get('/static/..%2f..%2f..%2fetc%2fpasswd')).status).toBe(404);
    expect((await t.client.get('/static/%E0%A4%A')).status).toBe(404);
  });
});

describe('shutdown', () => {
  it('rejects new requests with a 503 but keeps answering health checks', async () => {
    const t = await createTestApp({ routes });

    t.api.state.tracker.startShutdown();

    const res = await t.client.get('/open');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Service shutting down');
    // The tracker sits inside CORS and the security headers, and outside the request id
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toBeNull();
    expect((await t.client.get('/health')).status).toBe(200);
    expect((await t.client.get('/ready')).status).toBe(503);
    await t.close();
  });

  it('waits for active requests, then gives up after the timeout', async () => {
    const t = await createTestApp({ routes });
    const { tracker } = t.api.state;

    tracker.activeCount = 1;
    expect(await tracker.waitForDrain(0.05)).toBe(false);
    tracker.activeCount = 0;
    expect(await tracker.waitForDrain(0.05)).toBe(true);
    await t.close();
  });
});

describe('an app with its own classes', () => {
  class OwnRepos extends Repos {
    readonly own = true;
  }

  class OwnServices {
    constructor(readonly repos: OwnRepos) {}

    hello() {
      return `repos: ${this.repos.own}`;
    }
  }

  const own = typedContext<OwnServices, OwnRepos>();
  const ownRoutes = new Hono<Env<OwnServices, OwnRepos>>()
    .get('/hello', own.getServices, (c) => c.json({ hello: c.get('services').hello() }))
    .get('/boom', () => {
      throw new Error('boom');
    });

  it('builds them per request, and renders errors its own way', async () => {
    const t = await createTestApp<OwnServices>({
      routes: ownRoutes,
      reposClass: OwnRepos,
      servicesClass: OwnServices as never,
      errorHandler: (err, c) => c.json({ errors: { body: [err.message] } }, 422),
    });

    expect(await (await t.client.get('/hello')).json()).toEqual({ hello: 'repos: true' });
    const res = await t.client.get('/boom');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: { body: ['boom'] } });
    await t.close();
  });
});

describe('an infrastructure failure during auth', () => {
  it('is a 503 with Retry-After, not a 401 and not the guest', async () => {
    const api = createApi({
      reposClass: Repos,
      servicesClass: TestServices,
      routes,
      version: 'test',
      // Nothing listens here: opening the transaction fails with ECONNREFUSED
      dbConfig: { ...settings.db, port: 1 },
      clients: {
        bot: new FakeBot().bot,
        queue: new FakeQueue(),
        redis: new FakeRedis(),
        producer: new FakeProducer(),
      },
    });

    const res = await new TestClient(api.app).get('/needs-user');

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ detail: 'Service temporarily unavailable, please retry' });
    await api.state.db.close();
  });
});
