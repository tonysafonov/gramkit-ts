# gramkit-ts: port plan (shared brief for every agent)

Goal: a **full, normal-for-production TypeScript copy of gramkit** (`~/gramkit`, read-only source of truth), then a
side-by-side load test against the Python version. This is what a sensible team would ship, NOT a benchmark special:
no raw-SQL hot paths, no skipped layers, no tricks. If something is slower but normal, keep it normal.

*This is the brief the port was built from (2026-11-07), kept as a record. Source of truth was Python gramkit.*

## Shape: one flat app, no monorepo

Python `core/` + `apps/template-vue/` are merged into a single app. No workspaces, no core/app split, no `APP=` make layer.

```
package.json            one package, bun.lock (bun is the installer; the code must run on BOTH Node and Bun)
docker-compose.yml      local Postgres (host port 5460) + Redis (host port 6395); container names gramkit-ts-*
src/server/
  config.ts             env parsing (zod), same env var names as Python where sensible
  app.ts                createApi(): builds the Hono app, middleware order as Python's factory.py
  env.ts                Hono Env type: c.var.{requestId, db/tx, services, user, ...}
  runtime/              serve.node.ts (node:cluster + @hono/node-server), serve.bun.ts (Bun.spawn + reusePort), worker supervisors restart dead workers on both
  middleware/           request-id, tracker, security, cors, access-log, root-path, static, rate-limit, transaction
  db/                   client.ts, schema/*.ts (all tables), migrations/, repo/base.ts
  clients/              one per process: bot, queue, redis, rabbit, posthog, sentry
  lib/                  errors, logging (pino), i18n, request-context (AsyncLocalStorage), files, utils
  modules/<name>/       routes.ts, service.ts, repo.ts, schemas.ts (zod), *.test.ts   <- one owner per module
  services.ts           Services class: lazy getters over every module's service (Python RequestsService)
  repos.ts              Repos class: lazy getters over every repo (Python RequestsRepo)
  bot/                  grammY bot entry, shared middlewares
  worker/               BullMQ worker entry, cron schedule
  scripts/              CLI runner + backup/restore/wipe
src/web/                Vue 3 frontend (template-vue + core/frontend merged)
bench/conduit/          Conduit app built on the framework, as apps/conduit-bench is on Python gramkit
docs/python-contract/api.d.ts   Python's OpenAPI types: the REST contract to match
```

React template: out of scope for this copy (Vue only). Say so in the README.

## Stack (decided, don't re-litigate)

Hono 4 + `hc` typed client · zod 4 + @hono/zod-validator · Drizzle ORM + drizzle-kit · postgres.js (`drizzle-orm/postgres-js`,
works on Node and Bun, prepares statements itself) · pino · grammY · BullMQ (+ ioredis) · posthog-node · @sentry/node ·
socket.io · amqplib · vitest · Vue 3 + TanStack Query + Pinia + shadcn-vue + Tailwind 4, Vite.

Python → TS map: FastAPI → Hono · Pydantic → zod · SQLAlchemy → Drizzle · Alembic → drizzle-kit · arq → BullMQ ·
aiogram → grammY · slowapi → Redis rate-limit middleware · Kubb gen hooks → `hc` + TanStack Query · `Depends` → Hono
middleware + `c.var`. Logfire: optional, skip unless trivial, note it.

## Portability rule

Server code must run unchanged on Node 24+ and Bun 1.3+. Only `src/server/runtime/` may touch runtime-specific APIs.
Use `node:crypto`, `node:*` or web standards elsewhere; no `Bun.*`, no `Bun.sql`. Passwords: `bcryptjs` is too slow, use
`bcrypt` (native, works on both).

## Behaviour contract

1. **Same REST API:** same paths, methods, status codes, JSON field names (snake_case on the wire as in Python, even though
   TS internals are camelCase), same error shape. `docs/python-contract/api.d.ts` is the checklist; source is the Python router.
2. **Same database:** same table and column names, types, indexes, constraints as the SQLAlchemy models.
3. **Same semantics, line by line, on money and auth paths:** pessimistic locks (`.for('update')`) wherever Python uses
   `with_for_update`, idempotency keys, webhook re-fetch, dunning states, 503-not-401 on infrastructure errors in auth.
4. **One transaction per request:** the transaction middleware opens it, commits on success, rolls back on error. Repos
   never commit. Streaming routes release it early where Python does.
5. **One client per process:** Bot, queue, Redis, Rabbit, PostHog are created once in `clients/`, never per request.
6. Both `en` + `ru` strings wherever Python has them. `datetime.now(UTC)` semantics: store and compare UTC.
7. Port the behaviour, don't transliterate. Idiomatic TS: no Python-isms, no `any` unless a third-party type forces it.
   Don't add features. Comments only where the reason isn't obvious.

## Conventions

- Names: Python `get_or_create_user` → `getOrCreateUser`, same parameter order, so modules ported in parallel line up.
  Service `UserService` → `UsersService` at `modules/users/service.ts`, reached as `services.users`; repo as `repos.users`.
- Routes: each module exports a **chained** Hono router (`export const usersRoutes = new Hono<Env>().get(...).patch(...)`), so
  `hc` can infer types. Handlers stay thin: validate, call a service, map to the wire shape.
- Wire shape: `schemas.ts` has the zod schemas plus plain mapper functions (camelCase row → snake_case JSON).
  Responses are not re-validated at runtime (normal for TS; Pydantic does, this is a declared difference).
- Errors: throw `AppError` subclasses from `lib/errors.ts`; one global handler renders them.
- Tests: vitest, next to the code. `src/server/testing/` has the harness (app client, auth helpers, factories, fakes).
  Each test file gets its own database cloned from a template, so agents can run tests in parallel.
  Port the Python tests for your module from `core/backend/src/core/tests/` and `core/backend/src/core/testing/contracts/`.

## Ownership

Each module agent writes **only** in its own `src/server/modules/<name>/` (and the extra paths named in its brief).
It must not edit shared files: `app.ts`, `services.ts`, `repos.ts`, `db/schema/*`, `package.json`. Need a dependency or a schema change? List it in your final
report; the integrator applies it. Calls into a module not finished yet: use the naming rule and let typecheck fail
there; the integrator resolves it. Your own files must be free of type errors except for such cross-module calls.

## Bench parity (bench/conduit)

Same layers as the Python bench (`bench/conduit-python/`): createApi and its full middleware, one transaction per request, repos on
Drizzle's query builder (never `sql` raw for what the ORM can express), services, zod validation, one pino access-log
line per request, JWT, bcrypt cost 10, 10 DB connections per worker with no overflow, one worker per core, keep-alive 95 s,
nginx in front. Rate limiter off, as in the Python bench. Declared differences go in `bench/conduit/README.md`.
