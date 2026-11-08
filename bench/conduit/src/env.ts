/**
 * Conduit's environment, Python's `config.py`. Import this first: `src/server/config.ts` reads `process.env` when it
 * is imported, so everything it should see has to be set before that.
 *
 * The box passes `DATABASE_URL`, `JWT_SECRET`, `HOST` and `PORT` (SPEC.md "Runtime contract"). `DATABASE_URL` is split
 * into the `DB__*` variables here; the pool size (`DB__POOL_SIZE`) stays whatever the environment says. The rest keeps
 * gramkit's defaults, so the app runs as a template app would.
 */
const { env } = process;

if (env.DATABASE_URL) {
  const url = new URL(env.DATABASE_URL);
  env.DB__HOST = url.hostname || 'localhost';
  env.DB__PORT = url.port || '5432';
  env.DB__USER = decodeURIComponent(url.username) || 'postgres';
  env.DB__PASSWORD = decodeURIComponent(url.password);
  env.DB__NAME = url.pathname.slice(1) || 'conduit';
}

env.APP_NAME ??= 'conduit';
env.WEB__FRONTEND_URL ??= 'http://localhost';
// A template app has a bot token, so `getClients` builds one grammY `Bot` per process with it. A well-formed
// placeholder keeps that the same here; nothing is ever sent with it.
env.BOT__TOKEN ??= '123456789:conduit-bench-placeholder-token';

export const JWT_SECRET = env.JWT_SECRET ?? 'dev-secret';
