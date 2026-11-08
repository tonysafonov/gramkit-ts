# gramkit-ts

TypeScript port of the Python gramkit (`~/gramkit`, read-only source of truth). `docs/PORT-PLAN.md` is the binding brief:
read it first. This file is the working summary.

## Commands

```bash
make up            # Postgres (host 5460) + Redis (host 6395)
make dev           # dev server on Bun with reload, logs through pino-pretty
make bot / make worker   # the other two processes, with reload
make test          # vitest: `bun run test`, one file: `bunx vitest run src/server/modules/users`
make typecheck     # tsc
make lint          # biome (`bun run lint:fix` writes)
make migrate       # apply migrations
make route-parity  # routes against docs/python-contract/routes.txt, both ways
make smoke         # the real API, worker and bot on Bun and Node, against the local Postgres and Redis
make script name=demo_user_stats args='...'   # a CLI script; make restore-db file=<dump> replaces the local database
bun run db:generate -- --name <name>   # new migration from src/server/db/schema
bun run web:dev / web:build / web:typecheck / web:lint   # the frontend, from the repo root
```

Production is three processes, on one image (`Dockerfile`):

|        | Node (`bun run build` first) | Bun (source, no build)               |
| ------ | ---------------------------- | ------------------------------------ |
| API    | `node dist/main.node.js`     | `bun src/server/runtime/main.bun.ts` |
| Worker | `node dist/worker.node.js`   | `bun src/server/worker/main.ts`      |
| Bot    | `node dist/bot.node.js`      | `bun src/server/bot/main.ts`         |

Migrations: `node dist/migrate.node.js`. Env: `HOST`, `PORT`, `WORKERS` (default 1), `KEEP_ALIVE_TIMEOUT` (95 s), the rest
in `.env.example`.

**Docker.** `Dockerfile` is the backend image and takes `--build-arg RUNTIME=node|bun` (default node; Bun skips the
esbuild step and ships `src/server`). `docker-entrypoint.sh` is its entrypoint: `api` (runs migrations, then serves),
`bot`, `worker`, `migrate`, `script <name> ...`, `healthcheck`; it reads `JS_RUNTIME` (set from the build arg; not
`RUNTIME`, which `.env` also has and would override the image's). `Dockerfile.frontend` builds `src/web` (`VITE_*` are
build args) into nginx with `nginx/default.conf`, which proxies `/api/` (prefix stripped, Socket.IO included) to
`webhook:8000`. `docker-compose.prod.yml` is webhook, bot, worker, frontend, db, redis (`ENV_FILE` picks another env file);
`docker-compose.yml` is development (Postgres and Redis for `make dev`, plus an `app` profile). After touching any of these,
check both runtimes: `RUNTIME=bun docker compose -f docker-compose.prod.yml up -d --build --wait`, then
`curl localhost:8080/api/health`. The bot and worker exit without a real `BOT__TOKEN`; the webhook and frontend don't.

`typescript` is 5.9 for `vue-tsc` and `typescript-eslint`, which need its JS API; the server's `typecheck` runs the native
7 compiler, aliased as `typescript-native`. The frontend's packages are `devDependencies`: Vite bundles them, and
`bun install --production` must stay what the server needs.


## Layout

`src/server/`: `app.ts` (`createApi`), `api.ts` (this app's), `routes.ts` (all mounts), `env.ts`, `config.ts`,
`services.ts`, `repos.ts`, `auth/` (`getUser`, `getServices`, rbac, initData), `middleware/`, `db/`, `clients/`, `lib/`,
`runtime/`, `testing/`, `modules/<name>/{routes,service,repo,schemas}.ts`. `registries.ts` is what every entry point
calls at start (Python's `setup_infrastructure()`): broadcast keyboards, admin metrics. `bot/`, `worker/`, `scripts/` are
the other entry points; a module's bot handlers are `modules/<name>/bot.ts`, its jobs `modules/<name>/jobs.ts`.

Module agents write only in their module. Shared files (`app.ts`, `services.ts`, `repos.ts`, `routes.ts`, `db/schema/*`,
`package.json`) belong to the integrator: list what you need in your report. `services.ts` and `repos.ts` already have a
getter for every module, and `routes.ts` already mounts every router.

## Rules for module authors

**Routes.** A chained router, handlers stay thin: validate, call a service, map to the wire shape.

```ts
export const usersRoutes = new Hono<Env>()
  .get('/me', getUser, rateLimit(SOFT_LIMIT), (c) => c.json(toUserResponse(c.var.user)))
  .patch('/me', getUser, rateLimit(HARD_LIMIT), validate('json', UpdateUser), async (c) => {
    const user = await c.var.services.users.update(c.var.user.id, c.req.valid('json'));
    return c.json(toUserResponse(user));
  });
```

- Paths are relative to the mount in `routes.ts`. Exception: `subscriptionsRoutes` holds full paths, because
  `GET /subscriptions/` must keep its trailing slash, which a mounted `/` loses.
- The mounts in `routes.ts` decide your prefix: check them. Python's `routers.base` (no prefix) is split into
  `friendsRoutes` (users), `invitesRoutes`, `startRoutes`. The admin routers are mounted at `/admin`.
- Order of middleware: `getUser`, then `rateLimit`, then `validate`. FastAPI resolves dependencies first, so a bad token
  beats a bad body.
- Gate with `adminUser`, `ownerUser`, `requireRole(...)` from `auth/rbac`. They include `getUser`.
- Always render with `c.json`, `c.body`, `c.newResponse`. A raw `new Response()` skips the security and request-id
  headers, which are set before `next()`.
- `c.var` builds a new object on each access, `c.get('user')` doesn't. Use `c.get` in middleware and anything hot.

**Transactions.** `getServices` / `getUser` open the request's one transaction; chain them per route, as Python's
`Depends` is per route. A route with no DB work must not chain them: it would hold a connection. Commit is before the
response. **A throw rolls back; a returned error response commits**, same as Python: to undo writes, throw. Repos never
commit. The body is read before the transaction opens, as FastAPI does, so a slow upload holds no connection: read it
with `c.req.*`, never `c.req.raw.*`, which finds it already consumed. A streaming response commits when its handler
returns, so its body must not use `repos`; use `trackStream(c)` (`lib/streaming.ts`) so the access log and the tracker
follow the body. Work outside a request (bot, worker): `db.transaction((tx) => ...)` and `new Repos(tx)`.

**Locks.** Wherever Python says `with_for_update`: `.for('update')`, or `repos.x.getByIdWithLock(id)` from `BaseRepo`.

**Errors.** Throw `AppError` subclasses from `lib/errors.ts` (`{"detail": ...}`). Domain errors keep Python's names
(`UserNotFoundException`, ...): services throw them, routes translate. Anything else is a logged 500.
`services.auth.resolveUser` must map infrastructure failures with `isInfrastructureError` + `serviceUnavailable` (503 with
`Retry-After`, never a 401 or the guest).

**Names.** Python `get_or_create_user` → `getOrCreateUser`, same parameter order. Services are reached as `services.users`,
repos as `repos.users`. Rows are camelCase; JSON on the wire is snake_case, via plain mappers in `schemas.ts`. Responses
aren't re-validated. `UserSchema` is in `modules/users/schemas.ts`. Dates: store and compare UTC, `Date` instants.

**Clients.** Never build a client in a request. Services get `this.bot`, `this.producer`; `services.redis`, `services.queue`;
`posthog` from `clients/posthog`; `getSharedBot()` for code with no bot at hand. grammY calls go through `bot.api`.

**Portability.** Only `src/server/runtime/` may touch runtime-specific APIs. Elsewhere: `node:*` or web standards, no
`Bun.*`. Passwords: `bcrypt`. Env is loaded by `config.ts` on both runtimes (`bunfig.toml` turns off Bun's own loading).

**Strings.** Both `en` and `ru` wherever Python has them: `lib/i18n`. Locales in `lib/i18n/locales/`.

## Tests

Vitest, next to the code. Needs `make up`. Each file gets its own database cloned from a migrated template, so files run
in parallel, and each run has its own template, so runs do too. Nothing is mocked between the request and the database.

```ts
const t = await createTestApp();              // the real app; pass { routes } for your own
afterAll(() => t.close());

const user = await createUser(t.db);
const res = await t.client.post('/x', { a: 1 }, { headers: asUser(user) });  // asUser skips real auth
await t.db.select()...                        // outside the request: sees only committed data
t.fakes.bot.sent('sendMessage'); t.fakes.queue.jobs; t.fakes.posthog.events; t.fakes.redis; t.fakes.producer.messages;
```

`FakeYooKassa` sits behind `fetch` (`install()` / `uninstall()`). `generateTelegramInitData` signs a real `initData`
header. `captureLogs()` reads log lines. Port the Python tests for your module from `core/backend/src/core/tests/` and
`core/backend/src/core/testing/contracts/`. `bunx --bun vitest run` runs the suite on Bun.

## Things that differ from Python on purpose

- The database matches a **migrated** Python database (alembic head), not the models: `friendships` and `group_members`
  have composite primary keys, unique constraints are named `uq_users_*`. `src/server/db/schema.test.ts` diffs it against
  `docs/python-contract/schema-snapshot.txt`.
- `docs/python-contract/api.d.ts` is older than the Python routers, which win: it lacks most `/admin/*` routes and
  `/ready`, and lists `/admin/me`, `/admin/stats`, `/admin/demo-action`, which no Python router has anymore. The route
  list is `docs/python-contract/routes.txt`, generated from the FastAPI app by `scripts/python-routes.py`.
- A full pool fails after 30 s, like SQLAlchemy's `pool_timeout=30`, but postgres.js has no `pool_pre_ping` and no
  overflow: `DB__POOL_SIZE` is the cap, `DB__MAX_OVERFLOW` isn't read.
- Logfire isn't ported (optional in the plan): `OBSERVABILITY__LOGFIRE_TOKEN` isn't read. The core job
  `topup_daily_chat_messages_job` and `PaymentEventRepo.get_unprocessed` aren't either: no Python app registers or
  calls them (the app's `BalanceService` lacks the method the job calls).
- Drizzle sends query-builder queries with `prepare: false` (only `.prepare('name')` makes a named statement), so
  postgres.js' `prepare: true` has no effect on them; SQLAlchemy on asyncpg caches prepared statements.
- Hono answers `HEAD` on a `GET` route; FastAPI gives a 405. No `/docs` or `/openapi.json`.
- Python's 500s skip the middleware (no CORS or security headers); here they get them.
- Malformed JSON with a bad token is a 401 here: FastAPI parses the body before it resolves dependencies, so it answers
  422. `json_invalid`'s `loc` has no error position (FastAPI: `["body", 1]`) and no `ctx`.

**Auth.**

- Passwords are bcrypt (the plan), cost 10, not argon2: a hash from a Python database does NOT verify, so those users get
  a 401 until they reset. A real migration needs an argon2 verifier or a forced reset.
- The password goes through SHA-256 first (`modules/auth/password.ts`): bcrypt reads only 72 bytes, Python allows 128
  characters. The hashes start with `$2b$` but aren't interchangeable with plain bcrypt.
- Python's bugs from UUID and str slips aren't ported. `json.dumps` of a UUID `user_id` makes
  `POST /auth/login/telegram/code/send` (existing users) and `POST /auth/password/reset/start` (real users) a 500; here
  they work. `existing_user.id != user_id` compares a UUID to a str, so a same-user re-link says `telegram_already_used`;
  here it succeeds. A telegram link's `display_name` is `Ann`, not `Ann None`, for a user with no last name.
- A non-ASCII reset code is a 400 `code_invalid`; Python's `compare_digest` raises, a 500.
- `deeplink/start` records the IP from `x-forwarded-for` or `x-real-ip`: `request.client` has no portable equivalent. It
  is tracking data only.
- Hono throws on a cookie `Max-Age` over 400 days, so `SESSION__EXPIRE_DAYS` above 400 breaks login.
- The shared guest (a logged-out visitor) gets a 401 `not_authenticated` from `/auth/link/telegram/*` and
  `/auth/link/email/start|complete`. Python lets it through, so a link landed on the one row every logged-out visitor
  is (with a config owner's Telegram id: owner rights for everyone).
- Wrong email codes are counted with Redis `INCR` before the comparison (`<flow key>:attempts`). Python's
  read-check-write let concurrent requests try more than 5 codes per token.
- The Telegram-code limits (`auth_rate:send|verify:<username>`, 5 and 10 an hour) count with `INCR` too, so a
  burst of guesses can't all read the same count; the window starts at the first attempt (Python's restarts on each).
- Deep-link login (`/start auth_<token>`) and Telegram linking (`/start link_<token>`) ask first: the bot answers with a
  button (`auth_ok:<token>` / `link_ok:<token>`) and only the button logs in or links. The login prompt shows the IP
  (only a real one: the header is the client's) and the time it was asked for, the link prompt the web account
  (masked email or username). Python acts on the `/start`, so a victim tricked into opening someone's link handed
  over their session, or got their Telegram attached to that person's account.
- A password reset ends the user's sessions: it stores a cutoff (`<session prefix>valid_after:<user id>`), and
  `validateSession` refuses and deletes sessions created before it (one more Redis GET per cookie request). Python's
  survive the reset.
- The verification email escapes the name it greets (the user's display name); Python puts it in raw HTML.
- The shared guest gets a 401 `not_authenticated` from `POST /payments/start_purchase`, `GET /payments/{id}/status`
  and `POST /subscriptions/cancel`: what it bought would be every logged-out visitor's.

**Payments.**

- YooKassa goes through a `fetch` client (`modules/payments/providers/yookassa-api.ts`), there is no TS SDK. It sends the
  SDK's request bodies but not `metadata.cms_name` or the `YM-User-Agent` header, and doesn't validate webhook bodies
  field by field: the re-fetch decides everything.
- `POST /telegram-stars/webhook` is a 404 unless `createApi` gets a `telegramWebhookSecret`, and none is wired (the
  route is dormant). Python checks the secret only when one is set, and no app sets one, so its route takes any body,
  and the Stars provider trusts `successful_payment` as it arrives: a forged one grants the product, or 30 days per
  forged renewal.
- A Stars purchase must say `currency: 'XTR'` (else a 400): the invoice charges the amount in Stars whatever the
  currency, so Python's `USD` made a month cost 3 Stars. The amount is still `getPriceFor('XTR')`, which falls back
  to the first price when the product has no XTR one.
- A Stars renewal locks the subscription's first payment row before its charge-id dedup, so concurrent deliveries
  (webhook mode) record and reward it once. Python's get-then-create relies on the bot polling one update at a time.
- `Date` has millisecond precision. The renewal job reads `end_date` as text from Postgres (`endDateExact`) for the
  renewal key, so a Python-written microsecond `end_date` gives Python's key; anything else keyed on a `Date` would
  not. Wire dates have 3 fractional digits, not 6, and a JSON float renders as `555`, not `555.0`.

**Users and groups.** `getUserById`, `getByUsername` and `getByTgUsername` return `null` for a missing user (Python raises
a validation error); `updateUser` on a missing user throws `UserNotFoundException`; `removeMember` deletes by group and
user (Python's compared the id column to a dict and never worked).

**Messages.** A send returns `true | SendFailure`, and delivered is `result === true`: Python's `SendFailure` is falsy.

**Bot.** Webhook mode (`BOT__WEBHOOK_URL`) is new: Python only polls. It needs `BOT__WEBHOOK_SECRET` (config refuses
to load without one), or anyone reaching the port could post updates with any `from.id`. `/giftsub`'s usage strings escape `<` and `>`, which
Telegram rejects raw.

**Worker and scripts.** The job timeout is a race plus an abort signal: a handler that ignores `ctx.signal` keeps running
after its run failed, and after a grace period a shutdown stops waiting for it. `restoreBackup` reads the revision from
`alembic_version`, so a dump of this app restores with `restored_revision: null`.

**Demo.** Socket.IO polling needs sticky sessions with `WORKERS` above 1 (so does Python's). On Bun only `/socket.io/`
with the slash is served. The Rabbit consumer (`clients/rabbit-consumer.ts`) parses with `JSON.parse` where Python used
`eval`, and amqplib doesn't reconnect like `connect_robust`.
