# conduit-bench on gramkit-ts

**Front: nginx.**

The TypeScript twin of [`bench/conduit-python/`](../conduit-python/) (the Python gramkit bench): the [RealWorld "Conduit"](https://github.com/gothinkster/realworld)
API from the multicore server challenge (`SPEC.md`, 19 endpoints), built the way a gramkit-ts app is built, so the
challenge's load generator measures gramkit-ts' own overhead next to Python gramkit on the same box. One codebase, two
submissions:

| Submission        | Runtime      | Runs                                                   |
| ----------------- | ------------ | ------------------------------------------------------ |
| `gramkit-ts-node` | Node 26.12.1 | the esbuild bundle, `dist/main.node.js`                |
| `gramkit-ts-bun`  | Bun 1.4.4    | the TypeScript source, `bench/conduit/src/main.bun.ts` |

What is gramkit-ts here, as in an app built on it:

- `createApi` from `src/server/app.ts`: its lifespan, the whole middleware stack (CORS, security headers, request
  tracker, request id, one access-log line per request), logging, Sentry and PostHog setup. One grammY `Bot` (a
  placeholder token, as in Python; nothing is ever sent), one BullMQ queue, one Redis and one Rabbit client per process,
  built by `getClients`. The queue opens at startup, as Python's arq pool does;
- the request dependency is the framework's `getServices`: one transaction per request on the framework's pool, building
  this app's `ConduitServices` (`createApi({ servicesClass })`) from the process clients;
- routers → services → repos on the framework's `BaseRepo` and Drizzle's query builder (`sql` only for what Drizzle has
  no builder for: `array(...)`, `regexp_replace`, `coalesce`, `nextval`, where Python writes `func.*`), zod validation
  through the framework's `validate`, plain mappers for the responses;
- the framework's supervisors: `node:cluster` on Node, `Bun.spawn` + `reusePort` on Bun. `WORKERS=2`, one per core, 10 DB
  connections per worker, keep-alive 95 s.

What the spec forces, and so differs from a template app, the same as in Python: JWT auth (`Authorization: Token`, its own
middleware in `src/auth.ts`) instead of Telegram initData and session cookies, and one error shape,
`{"errors": {"body": [...]}}`, for every error (`src/errors.ts`: `createApi({ errorHandler })` and a 404/405 handler).
The rate limiter isn't applied to these routes, and `RATE_LIMIT__ENABLED=false`. Not eligible for the leaderboard:
rule 2 forbids Redis.

## Differences from the Python bench

Each is what a normal app on this stack does. None is a shortcut taken for the benchmark.

**On every request:**

- **Responses aren't validated at runtime.** FastAPI runs each response through its Pydantic `response_model`; here the
  zod schemas cover requests only, and responses are plain mappers. Less work per request than Python.
- **No `pool_pre_ping`.** SQLAlchemy checks a connection each time it leaves the pool; postgres.js has no such option.
  Less work per request than Python.
- **No overflow.** `DB__MAX_OVERFLOW` isn't read: `DB__POOL_SIZE` is the cap. The same as Python's
  `tuning/workers2-pool10.env` (10 + 0), so that run is the one to compare with. A request past the pool waits up to 30 s
  on both.
- **Drizzle's statements aren't prepared.** A query builder awaited directly goes out with `prepare: false`, so Postgres
  parses and plans every execution. SQLAlchemy on asyncpg caches prepared statements per connection. In the Postgres log:
  `execute <unnamed>` here, a named statement with the overlay below. More work per request than Python, and normal for
  Drizzle. `overlays/prepared` measures it.
- **The SQL is built on every request.** SQLAlchemy caches the compiled statement (`query_cache_size=1200`). Drizzle has
  no such cache: the query objects and their SQL string are made each time, the overlay included (see its README).
- **pino async instead of a listener thread.** Python hands each log record to a `QueueListener` thread. pino formats on
  the event loop, buffers (sonic-boom, `sync: false`) and writes with an async `fs.write`, which on Node shares the libuv
  thread pool with bcrypt. The access log itself is the same: one line per request, written at the end of the request,
  with the request id and the user. It is JSON here.
- **The transaction opens earlier.** `getServices` sends `BEGIN` before the handler runs. SQLAlchemy's session starts with
  the first query. So `POST /api/users` and `PUT /api/user` with a new password hold a pooled connection, in a
  transaction, for the bcrypt hash; Python hashes before taking one. `POST /api/users/login` holds one for bcrypt on both.
  A cost against TypeScript, on rare requests: 0.5% of sessions register.
- **No `gc.freeze()`.** `create_api` moves startup objects out of the cyclic GC's reach. V8 and JavaScriptCore have no
  such call.

**Runtime and libraries:**

- **Workers.** uvicorn's workers share one listening socket. Node's cluster primary accepts every connection and passes it
  to a free worker, so a burst can spread unevenly (11 / 30 of 41 connections in the box check below). Bun's workers each
  listen with `SO_REUSEPORT` and the kernel hashes connections over them (20 / 21). Each runtime also has one supervisor
  process that serves nothing. On Bun, `idleTimeout` also covers a request in progress.
- **Node runs a bundle, Bun and Python run source.** Dependencies stay external in the bundle, as in `scripts/build.ts`.
  Unlike `scripts/build.ts`, it is split, so the supervisor doesn't load what only workers need (RSS 180 MB → 80 MB).
- **JWT is `hono/jwt`,** on WebCrypto, so it is async. PyJWT is synchronous.
- **bcrypt is the native `bcrypt` package,** on the runtime's thread pool. Python's goes through Starlette's thread pool.
  Cost 10 on both, and over 72 bytes is rejected on both (`bcrypt` itself would cut the password).
- **Logfire isn't ported.** It has no token in Python's runs. Sentry and PostHog are set up with no key, on both.

**The API, none of it in the conformance suite or the load:**

- Malformed JSON with a bad token is a 401 here. FastAPI parses the body before it resolves dependencies: a 422.
- Hono answers `HEAD` on a `GET` route; FastAPI gives a 405. No `/docs` or `/openapi.json`. A 500 carries the
  middleware's headers; Python's skips them.
- Validation messages differ (the spec leaves them free).
- Ids and offsets are JS numbers, not bigints. A value past 2^53 fits no row, so it is clamped to 2^53 - 1 and finds
  nothing. On the feed that also means an offset near 2^63 is an empty page here, where Python's `limit + offset`
  overflows in SQL.

**The SQL, same results:**

- `POST /api/articles`: tags go in with `VALUES ... ON CONFLICT DO NOTHING` and `IN (...)`, where Python has `unnest` and
  `ANY`: Drizzle's insert-from-select must name every column, `tags.id` included, and it expands arrays. Two statements
  on both. The article's insert-from-select names `created_at` and `updated_at` as `now()`, for the same reason.
- The feed's lateral `LIMIT` is `limit + offset` added in JS, not in SQL.
- `exists` selects `1` where SQLAlchemy selects `*`.

**Structure:**

- No `_core` aggregators: there is no core/app split in gramkit-ts. `ConduitRepos` and `ConduitServices` are one object
  each per request; Python builds two of each.

## Layout on the box

`push.sh` assembles `/opt/challenge/subs/<name>/`: `install.sh` (root: Redis if it's missing, Node 26.12.1 and Bun 1.4.4
under `/opt/js`), `build.sh` (dependencies from gramkit-ts' `bun.lock`, the bundle on Node), `start.sh`, `runtime.env`
(which runtime this submission is), `tuning.env`, `package.json`, `bun.lock`, `bunfig.toml`, `src/server/` (the framework,
no tests), `bench/conduit/src/` (this app) and `GIT_HEAD`. No `node_modules`.

## Run

```bash
bench/conduit/push.sh root@<target> gramkit-ts-node      # copy, install, build on the box
bench/conduit/push.sh root@<target> gramkit-ts-bun       # a name ending in -bun runs on Bun
ssh root@<target> /opt/conduit-tools/switch.sh gramkit-ts-node   # conformance, fresh DB, start
ssh root@<target> /opt/conduit-tools/switch.sh gramkit-ts-node --no-conformance
```

`switch.sh` stops at any conformance failure, and on a 2-core box `articles.list.offset-past-end`
(`offset=100000000`) always times out, in Python too. Check `/root/conformance-<name>.txt`, then start with
`--no-conformance`.

Locally, against the `make up` Postgres and Redis, on both runtimes with a small seed (the conformance suite needs the
box):

```bash
bench/conduit/test/local.sh          # or: local.sh bun; OVERLAYS=prepared local.sh
```

Tuning steps: put `WORKERS=...` / `DB__POOL_SIZE=...` in a file and pass it as `TUNING_ENV=<file>` to `push.sh` under
another name. Default: `tuning/workers2-pool10.env`. A step that changes code is an overlay: `OVERLAYS="prepared"
bench/conduit/push.sh root@<target> gramkit-ts-node-prepared` (`overlays/prepared/README.md`).
