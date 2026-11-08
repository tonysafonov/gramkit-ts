/**
 * The test app: the real `createApi` with its full middleware, on this file's own database, with fakes for everything
 * that talks to the outside. Nothing is mocked between the request and the database.
 *
 *     const t = await createTestApp();
 *     afterAll(() => t.close());
 *
 *     const user = await createUser(t.db);
 *     const res = await t.client.get('/users/me', { headers: asUser(user) });
 *     expect(res.status).toBe(200);
 */
import type { Hono, Schema } from 'hono';
import { hc } from 'hono/client';
import { type Api, type CreateApiOptions, createApi } from '../app';
import { generateSecretKey, TelegramAuthenticator } from '../auth/telegram';
import { posthog } from '../clients/posthog';
import { settings } from '../config';
import type { Database } from '../db/client';
import type { Env } from '../env';
import { Repos } from '../repos';
import { routes as appRoutes } from '../routes';
import type { Services } from '../services';
import { TestServices } from './auth';
import { createTestDatabase } from './database';
import { FakeBot } from './fakes/bot';
import { FakePostHog } from './fakes/posthog';
import { FakeProducer } from './fakes/producer';
import { FakeQueue } from './fakes/queue';
import { FakeRedis } from './fakes/redis';

interface RequestOptions {
  headers?: Record<string, string>;
}

/** `app.request` with JSON bodies. */
export class TestClient {
  // biome-ignore lint/suspicious/noExplicitAny: serves any app's router, whatever its Env
  constructor(private readonly app: Hono<any, any, any>) {}

  request(path: string, init?: RequestInit): Promise<Response> {
    return Promise.resolve(this.app.request(path, init));
  }

  private send(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    const isJson = body !== undefined;
    return this.request(path, {
      method,
      headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: isJson ? JSON.stringify(body) : undefined,
    });
  }

  get(path: string, options?: RequestOptions) {
    return this.send('GET', path, undefined, options);
  }

  post(path: string, body?: unknown, options?: RequestOptions) {
    return this.send('POST', path, body, options);
  }

  put(path: string, body?: unknown, options?: RequestOptions) {
    return this.send('PUT', path, body, options);
  }

  patch(path: string, body?: unknown, options?: RequestOptions) {
    return this.send('PATCH', path, body, options);
  }

  delete(path: string, options?: RequestOptions) {
    return this.send('DELETE', path, undefined, options);
  }
}

export interface TestApp<S = Services> {
  api: Api<S, Repos>;
  app: Api<S, Repos>['app'];
  /** The pool of this file's database, outside any request. */
  db: Database;
  databaseName: string;
  client: TestClient;
  fakes: { bot: FakeBot; queue: FakeQueue; redis: FakeRedis; producer: FakeProducer; posthog: FakePostHog };
  /** Run the request through the app, typed: `t.typed<AppType>().users.me.$get()`. */
  typed<T extends Hono<Env, Schema, string>>(): ReturnType<typeof hc<T>>;
  close(): Promise<void>;
}

type TestAppOptions<S> = Partial<Omit<CreateApiOptions<S, Repos>, 'dbConfig'>>;

export async function createTestApp<S = TestServices>(options: TestAppOptions<S> = {}): Promise<TestApp<S>> {
  const database = await createTestDatabase();
  const fakes = {
    bot: new FakeBot(),
    queue: new FakeQueue(),
    redis: new FakeRedis(),
    producer: new FakeProducer(),
    posthog: new FakePostHog().install(),
  };

  const api = createApi<S, Repos>({
    routes: appRoutes,
    reposClass: Repos,
    servicesClass: TestServices as never,
    title: 'Test API',
    version: 'test',
    telegramAuth: new TelegramAuthenticator(generateSecretKey(settings.bot.token), settings.bot.initDataMaxAge),
    ...options,
    clients: {
      bot: fakes.bot.bot,
      queue: fakes.queue,
      redis: fakes.redis,
      producer: fakes.producer,
      ...options.clients,
    },
    dbConfig: database.config,
  });
  const client = new TestClient(api.app);

  return {
    api,
    app: api.app,
    db: api.state.db.db,
    databaseName: database.name,
    client,
    fakes,
    typed: <T extends Hono<Env, Schema, string>>() =>
      hc<T>('http://localhost', {
        fetch: (input: string | URL | Request, init?: RequestInit) => api.app.request(input as string, init),
      }),
    async close() {
      posthog.useClient(null);
      await api.state.db.close();
      await database.drop();
    },
  };
}
