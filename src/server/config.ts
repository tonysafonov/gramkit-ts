/**
 * Settings from the environment, same variable names as the Python app (`DB__HOST`, `WEB__FRONTEND_URL`, ...).
 *
 *     import { settings } from './config';
 *     settings.db.host; settings.session.cookieName; settings.rbac.ownerIds;
 *
 * `.env` (or `ENV_FILE`) is loaded here, real environment variables win. Parsed once per process at import.
 */
import { config as loadEnvFile } from 'dotenv';
import { z } from 'zod';

const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Pydantic's bool parsing: `True`, `on`, `0`, ... (an empty value falls back to the default). */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return fallback;
      const lowered = value.toLowerCase();
      if (TRUE.has(lowered)) return true;
      if (FALSE.has(lowered)) return false;
      ctx.addIssue({ code: 'custom', message: `invalid boolean: ${value}` });
      return z.NEVER;
    });

const str = (fallback = '') => z.string().default(fallback);
const num = (fallback: number) => z.coerce.number().default(fallback);

/** A JSON list, as pydantic-settings reads it: `RBAC__OWNER_IDS=[1,2]`. */
const jsonList = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .optional()
    .transform((value, ctx): z.output<T>[] => {
      if (value === undefined || value === '') return [];
      try {
        return z.array(item).parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: `expected a JSON list, got: ${value}` });
        return z.NEVER;
      }
    });

const envSchema = z.object({
  APP_NAME: str('template'),
  ENVIRONMENT: str('local'),
  DEBUG: bool(false),
  DEBUG_USERNAME: str(),
  LOG_LEVEL: str('info'),

  DB__HOST: str('localhost'),
  DB__PORT: num(5432),
  DB__USER: str('postgres'),
  DB__PASSWORD: str(),
  DB__NAME: str('app'),
  // Connections per process (HTTP worker, bot, BullMQ worker). Keep the sum over every process under Postgres'
  // max_connections. Past the pool a request waits for a connection (30 s); postgres.js has no overflow to configure.
  DB__POOL_SIZE: num(10),

  REDIS__HOST: str('localhost'),
  REDIS__PORT: num(6379),
  REDIS__PASSWORD: str(),

  RABBIT__URL: str('amqp://guest:guest@localhost:5672/'),
  RABBIT__QUEUE_NAME: str('default'),

  SESSION__EXPIRE_DAYS: num(7),
  SESSION__COOKIE_SECURE: bool(true),
  SESSION__COOKIE_HTTPONLY: bool(true),
  SESSION__COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION__COOKIE_DOMAIN: z.string().optional(),

  BOT__TOKEN: str(),
  BOT__URL: str(),
  // Unset: the bot process long-polls. Set: it registers this webhook and serves it on BOT__WEBHOOK_PORT, and
  // BOT__WEBHOOK_SECRET is required (Telegram's secret_token: 1-256 of A-Z, a-z, 0-9, _ and -).
  BOT__WEBHOOK_URL: str(),
  BOT__WEBHOOK_PORT: num(8081),
  // How long a Mini App's signed initData logs in, from its auth_date, in seconds; 0: forever, as Python. initData
  // can't be revoked, so a leaked one (a log, a HAR file) would otherwise work for good.
  BOT__INIT_DATA_MAX_AGE: num(86_400),
  BOT__WEBHOOK_SECRET: str().refine((value) => value === '' || /^[A-Za-z0-9_-]{1,256}$/.test(value), {
    message: "Telegram's secret_token allows 1-256 characters of A-Z, a-z, 0-9, _ and -",
  }),

  WEB__APP_URL: str(),
  WEB__FRONTEND_URL: str(),
  WEB__API_URL: str(),
  WEB__API_ROOT_PATH: str(),
  WEB__CORS_ORIGINS: jsonList(z.string()),
  WEB__SHUTDOWN_DRAIN_TIMEOUT: num(30),

  PAYMENT__SHOP_ID: str(),
  PAYMENT__SECRET_KEY: str(),
  PAYMENT__RECEIPT_EMAIL: str(),

  EMAIL__API_KEY: str(),
  EMAIL__FROM_ADDRESS: str(),
  EMAIL__FROM_NAME: str(),

  OPENAI__API_KEY: str(),
  OPENAI__BASE_URL: str('https://api.openai.com/v1'),

  OBSERVABILITY__SENTRY_DSN: str(),
  OBSERVABILITY__SENTRY_TRACES_SAMPLE_RATE: num(0.05),
  OBSERVABILITY__SENTRY_PROFILES_SAMPLE_RATE: num(0),
  OBSERVABILITY__POSTHOG_API_KEY: str(),
  OBSERVABILITY__POSTHOG_HOST: str('https://app.posthog.com'),
  // Logfire isn't ported (PORT-PLAN: optional): OBSERVABILITY__LOGFIRE_TOKEN isn't read. The environment name is kept,
  // it tags Sentry events and admin messages.
  OBSERVABILITY__LOGFIRE_ENVIRONMENT: str('development'),

  RBAC__OWNER_IDS: jsonList(z.number().int()),

  RATE_LIMIT__ENABLED: bool(true),

  HOST: str('0.0.0.0'),
  PORT: num(8000),
  WORKERS: num(1),
  KEEP_ALIVE_TIMEOUT: num(95),
});

export function parseSettings(env: Record<string, string | undefined>) {
  const e = envSchema.parse(env);
  // Without a secret the webhook would take forged updates (any `from.id`) from anyone who can reach the port
  if (e.BOT__WEBHOOK_URL && !e.BOT__WEBHOOK_SECRET) {
    throw new Error('BOT__WEBHOOK_SECRET is required when BOT__WEBHOOK_URL is set');
  }
  const redisAuth = e.REDIS__PASSWORD ? `:${e.REDIS__PASSWORD}@` : '';
  return {
    appName: e.APP_NAME,
    environment: e.ENVIRONMENT,
    debug: e.DEBUG,
    debugUsername: e.DEBUG_USERNAME,
    logLevel: e.LOG_LEVEL,
    db: {
      host: e.DB__HOST,
      port: e.DB__PORT,
      user: e.DB__USER,
      password: e.DB__PASSWORD,
      name: e.DB__NAME,
      poolSize: e.DB__POOL_SIZE,
    },
    redis: {
      host: e.REDIS__HOST,
      port: e.REDIS__PORT,
      password: e.REDIS__PASSWORD,
      url: `redis://${redisAuth}${e.REDIS__HOST}:${e.REDIS__PORT}/0`,
    },
    rabbit: { url: e.RABBIT__URL, queueName: e.RABBIT__QUEUE_NAME },
    session: {
      expireDays: e.SESSION__EXPIRE_DAYS,
      cookieSecure: e.SESSION__COOKIE_SECURE,
      cookieHttponly: e.SESSION__COOKIE_HTTPONLY,
      cookieSamesite: e.SESSION__COOKIE_SAMESITE,
      cookieDomain: e.SESSION__COOKIE_DOMAIN,
      cookieName: `${e.APP_NAME}_session`,
      keyPrefix: `${e.APP_NAME}:session:`,
    },
    bot: {
      token: e.BOT__TOKEN,
      url: e.BOT__URL,
      webhookUrl: e.BOT__WEBHOOK_URL,
      webhookPort: e.BOT__WEBHOOK_PORT,
      webhookSecret: e.BOT__WEBHOOK_SECRET,
      initDataMaxAge: e.BOT__INIT_DATA_MAX_AGE,
    },
    web: {
      appUrl: e.WEB__APP_URL,
      frontendUrl: e.WEB__FRONTEND_URL,
      apiUrl: e.WEB__API_URL,
      apiRootPath: e.WEB__API_ROOT_PATH,
      corsOrigins: e.WEB__CORS_ORIGINS,
      shutdownDrainTimeout: e.WEB__SHUTDOWN_DRAIN_TIMEOUT,
    },
    payment: {
      shopId: e.PAYMENT__SHOP_ID,
      secretKey: e.PAYMENT__SECRET_KEY,
      receiptEmail: e.PAYMENT__RECEIPT_EMAIL,
      enabled: Boolean(e.PAYMENT__SHOP_ID && e.PAYMENT__SECRET_KEY),
    },
    email: {
      apiKey: e.EMAIL__API_KEY,
      fromAddress: e.EMAIL__FROM_ADDRESS,
      fromName: e.EMAIL__FROM_NAME,
      enabled: Boolean(e.EMAIL__API_KEY && e.EMAIL__FROM_ADDRESS),
    },
    openai: { apiKey: e.OPENAI__API_KEY, baseUrl: e.OPENAI__BASE_URL, enabled: Boolean(e.OPENAI__API_KEY) },
    observability: {
      sentryDsn: e.OBSERVABILITY__SENTRY_DSN,
      sentryTracesSampleRate: e.OBSERVABILITY__SENTRY_TRACES_SAMPLE_RATE,
      sentryProfilesSampleRate: e.OBSERVABILITY__SENTRY_PROFILES_SAMPLE_RATE,
      posthogApiKey: e.OBSERVABILITY__POSTHOG_API_KEY,
      posthogHost: e.OBSERVABILITY__POSTHOG_HOST,
      environment: e.OBSERVABILITY__LOGFIRE_ENVIRONMENT,
      sentryEnabled: Boolean(e.OBSERVABILITY__SENTRY_DSN),
      posthogEnabled: Boolean(e.OBSERVABILITY__POSTHOG_API_KEY),
    },
    rbac: { ownerIds: e.RBAC__OWNER_IDS },
    rateLimit: { enabled: e.RATE_LIMIT__ENABLED },
    server: { host: e.HOST, port: e.PORT, workers: e.WORKERS, keepAliveTimeout: e.KEEP_ALIVE_TIMEOUT },
  };
}

export type Settings = ReturnType<typeof parseSettings>;
export type DbConfig = Settings['db'];
export type WebConfig = Settings['web'];

loadEnvFile({ path: process.env.ENV_FILE ?? '.env', quiet: true });

export const settings: Settings = parseSettings(process.env);
