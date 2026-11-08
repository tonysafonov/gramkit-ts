/**
 * Hono's `Env`: what a request carries on `c.var`.
 *
 * `Env` is the base every router is typed with. The other three come from the middleware a route chains, so a handler
 * can only read what its middleware set:
 *
 *     new Hono<Env>().get('/me', getUser, (c) => c.var.user)
 *
 * `c.var` builds a new object on every access; prefer `c.get('user')` in code that runs on every request.
 */
import type { Bot } from 'grammy';
import type { TelegramAuthenticator } from './auth/telegram';
import type { Clients, QueueClient, RabbitProducer, RedisClient } from './clients';
import type { WebConfig } from './config';
import type { Db, DbClient, Tx } from './db/client';
import type { RequestTracker } from './middleware/tracker';
import type { UserSchema } from './modules/users/schemas';
import type { Repos } from './repos';
import type { Services } from './services';

export type ReposClass<R> = new (db: Db) => R;

/** A request's service aggregator, built by `getServices` (Python's `services_class(repo, producer, bot, redis, arq)`). */
export type ServicesClass<S, R> = new (
  repos: R,
  producer: RabbitProducer,
  bot: Bot | null,
  redis: RedisClient,
  queue: QueueClient,
) => S;

/** Per-app objects, Python's `app.state`. Built once by `createApi`. */
export interface AppState<S = Services, R = Repos> {
  title: string;
  version: string;
  config: WebConfig;
  db: DbClient;
  clients: Clients;
  tracker: RequestTracker;
  reposClass: ReposClass<R>;
  servicesClass: ServicesClass<S, R>;
  telegramAuth: TelegramAuthenticator | null;
  /** Language of the shared guest when the request sends no X-App-Locale. `null`: the guest row's own. */
  guestLocale: string | null;
  /** Turn a webhook's signature check on. Nothing sets them yet, as in Python. */
  yookassaWebhookSecret?: string;
  telegramWebhookSecret?: string;
}

interface BaseVariables<S, R> {
  requestId: string;
  state: AppState<S, R>;
  /** Set for a streaming response, resolved when its body ends. See `trackStream`. */
  streamDone?: Promise<void>;
}

interface TxVariables<S, R> extends BaseVariables<S, R> {
  tx: Tx;
  repos: R;
}

interface ServicesVariables<S, R> extends TxVariables<S, R> {
  services: S;
}

interface UserVariables<S, R> extends ServicesVariables<S, R> {
  user: UserSchema;
}

export type Env<S = Services, R = Repos> = { Variables: BaseVariables<S, R> };
export type TxEnv<S = Services, R = Repos> = { Variables: TxVariables<S, R> };
export type ServicesEnv<S = Services, R = Repos> = { Variables: ServicesVariables<S, R> };
export type UserEnv<S = Services, R = Repos> = { Variables: UserVariables<S, R> };
