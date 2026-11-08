# gramkit-ts

Production-ready starter for Telegram Mini Apps and web applications, in TypeScript end to end.

**[Live Demo](https://react.antonchaynik.ru)** · Python edition: **[gramkit](https://github.com/tonysafonov/gramkit)**

> The demo runs Python gramkit's backend; the UI and the REST API are the same in both editions.

This is a TypeScript port of [gramkit](https://github.com/tonysafonov/gramkit) (Python: FastAPI + SQLAlchemy). The REST API
and the database schema are the same, so the Vue frontend talks to either backend. It runs on **Node 24+ or Bun 1.3+**,
and the Docker image picks the runtime with a build arg.

> Telegram features are opt-in. Leave `BOT__TOKEN` empty and you have a standard web app (run only the webhook and the
> frontend, see [Deploy](#deploy)).

## Features

| Feature | What You Get |
|---------|--------------|
| **Authentication** | Email + OTP verification, Telegram login (Mini App `initData`, bot deep link, one-time code), password reset, account linking |
| **Role-Based Access** | Admin/Owner/User roles, owner ids from config, protected routes |
| **Real-Time Data** | Socket.IO, polling, streaming responses |
| **Mobile-First** | Responsive layouts, bottom navigation, Telegram Mini App detection |
| **Typed API** | Hono routes with zod validation; the frontend client is typed from the server's own types |
| **i18n + Theming** | `en` and `ru` on the server and in the UI, dark/light mode |
| **Payments** | YooKassa (cards, auto-renewal) and Telegram Stars (one-time + subscriptions), refunds, pessimistic locking on the money path |
| **Bot Notifications** | Scheduled per-user-local-time sends with a delivery log and blocked-bot detection |
| **Admin Alerts** | Purchase / renewal / cancel / failure alerts and deploy announcements in Telegram |
| **Background Jobs** | BullMQ on Redis: notifications, renewals, scheduled jobs, nightly database backups |
| **Admin panel** | Overview, users, analytics, audit log, tasks, broadcasts, marketing links |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | TypeScript, Hono, zod, Drizzle ORM, postgres.js |
| Runtime | Node 24+ (esbuild bundles) or Bun 1.3+ (TypeScript source) |
| Jobs / bot | BullMQ, grammY |
| Frontend | Vue 3, Vite, TanStack Query, Pinia, shadcn-vue (reka-ui), Tailwind CSS v4 |
| Database | PostgreSQL 17, Redis 7 |
| Observability | Sentry, PostHog (both optional) |
| Optional | RabbitMQ consumer (the demo), Cloudflare Tunnel for Mini App testing |

## What's different from Python gramkit

- **One app, no monorepo.** The Python repo has `core/` (shared) and `apps/` (per product) with an `APP=` make layer.
  Here core and the Vue template are merged into one package: `src/server` (API, bot, worker, scripts) and `src/web`
  (frontend).
- **Vue only.** There is no React/Next template.
- **Same REST API, same schema.** The database matches a migrated Python database, and the route list is checked against
  the Python one (`make route-parity`). Env variable names are the same too.
- **No OpenAPI and no Kubb.** There is no `/docs` and no generated hooks: the frontend imports the server's types
  directly.
- **Two runtimes.** Only `src/server/runtime/` touches runtime-specific APIs; everything else is `node:*` or web
  standards.
- **Webhook mode for the bot** (`BOT__WEBHOOK_URL`) is new; Python only long-polls.
- **Hardened on purpose:** deep-link login and Telegram linking ask for a confirmation button, a password reset ends the
  user's sessions, a forged Stars payment grants nothing. The full list of differences is in
  [CLAUDE.md](CLAUDE.md). Passwords are bcrypt: **hashes from a Python database do not verify**, so migrated users
  reset their password.
- **Not ported:** Logfire, and a few core jobs no Python app registers.
- Hono answers `HEAD` on a `GET` route; FastAPI gives a 405.

## Quick Start

```bash
cp .env.example .env
bun install
make up && make migrate      # Postgres on :5460, Redis on :6395
make dev                     # the API on :8000
make bot                     # the bot (needs BOT__TOKEN), in another terminal
make worker                  # background jobs, in another terminal
bun run web:dev              # the frontend on http://localhost:5174, proxies /api to :8000
```

Requirements: Docker, [Bun](https://bun.sh) 1.3+, Node 24+, Make.
Optional: a bot token from @BotFather, a Cloudflare Tunnel for Mini App testing, YooKassa credentials.

## Deploy

`docker-compose.prod.yml` runs the whole thing: **webhook** (the API), **bot**, **worker**, **frontend** (nginx),
**postgres**, **redis**. Only the frontend publishes a port, and it proxies `/api` (Socket.IO included) to the webhook,
so the browser sees one origin and the session cookie just works. Put TLS and your domain in front of it (Dokploy, Caddy,
a host nginx, Cloudflare).

```bash
cp .env.example .env
# edit .env: ENVIRONMENT=production, DEBUG=false, DB__PASSWORD, BOT__TOKEN, BOT__URL, the WEB__* public URLs,
# SESSION__COOKIE_SECURE=true, RBAC__OWNER_IDS=[your telegram id]
docker compose -f docker-compose.prod.yml up -d --build
curl localhost:8080/api/health        # {"status":"healthy","version":...}
```

- **Runtime.** `RUNTIME=node` (default) builds the esbuild bundles and runs them on Node 24. `RUNTIME=bun` skips the build
  and runs the TypeScript source on Bun. Set it in `.env` or per command, and rebuild:
  `RUNTIME=bun docker compose -f docker-compose.prod.yml up -d --build`. By hand:
  `docker build --build-arg RUNTIME=bun -t gramkit-ts:bun .`.
- **One image, several commands.** `docker-entrypoint.sh` takes `api` (applies migrations, then serves), `bot`, `worker`,
  `migrate`, `script <name> [args]` and `healthcheck`, for example
  `docker compose -f docker-compose.prod.yml run --rm webhook script demo_user_stats`.
- **Web-only (no Telegram).** Leave `BOT__TOKEN` empty and start only what needs no token:
  `docker compose -f docker-compose.prod.yml up -d webhook frontend`. The bot and the worker refuse to start without one.
- **Bot webhook mode.** Set `BOT__WEBHOOK_URL` (a public HTTPS URL that reaches the bot container's `BOT__WEBHOOK_PORT`)
  and `BOT__WEBHOOK_SECRET`. Empty: the bot long-polls, which exposes nothing.
- **Scaling.** `WORKERS=N` starts N API processes behind one port. Use one per core, and keep `N * DB__POOL_SIZE` below
  Postgres' `max_connections`. Socket.IO polling needs sticky sessions above 1.
- **Frontend settings** (`VITE_*`) are baked in at build time: change them, then rebuild the `frontend` image.
- **Data** lives in the `pgdata` and `redisdata` volumes. The worker backs the database up nightly to the owners in
  Telegram, and the owner-only `/backup` command does it on demand.
- `ENV_FILE=path` makes compose and the app read another env file.

`docker-compose.yml` is the development one: `make up` starts only Postgres and Redis, for the host-run `make dev`.

## Performance

Load-tested with the method of Python gramkit's README: Arjay McCandless's multicore-server-challenge Conduit (19
endpoints) built on this framework (`bench/conduit/`), scored by the challenge's load generator against Python gramkit
and the challenge's plain FastAPI example on the **same box, same night**: 2 dedicated vCPU / 4 GB, Postgres and nginx
on the box, 2 workers each. Score = users held 5 minutes with p95 < 500 ms, p99 < 1 s, < 1 % errors.

| Conduit, users held 5 min (2026-11-08) | Users | req/s | App CPU per request |
|---|---:|---:|---:|
| Python gramkit (FastAPI + SQLAlchemy) | 1,200 | 315 | 3.9 ms |
| **gramkit-ts on Node** | **2,700** | 677 | 1.5 ms |
| **gramkit-ts on Bun** | **2,800** | 706 | 1.3 ms |
| gramkit-ts on Node, hot queries `.prepare()`d | 3,300 | 836 | 1.4 ms |
| gramkit-ts on Bun, hot queries `.prepare()`d | 3,700 | 953 | 1.1 ms |
| Reference: plain FastAPI + asyncpg, no ORM, no middleware | 2,700 | 709 | 1.4 ms |

Details, CPU split, memory and caveats: [`docs/benchmarks/2026-11-08-conduit.md`](docs/benchmarks/2026-11-08-conduit.md). Both benches are in this repo: [`bench/conduit/`](bench/conduit/) (TypeScript) and [`bench/conduit-python/`](bench/conduit-python/) (Python gramkit), with raw results in [`bench/conduit/results/`](bench/conduit/results/).

Same workload as [gramkit's Performance section](https://github.com/tonysafonov/gramkit#performance); the numbers above come from one night on one box, so compare them with each other, not with other dates (the box drifts by ~10%).

## Commands

```bash
make up / down            # Postgres + Redis for development
make dev / bot / worker   # the three processes, with reload (Bun)
make test                 # vitest, a real Postgres per test file
make typecheck            # tsc (the native TypeScript 7 compiler)
make lint                 # biome
make migrate              # apply migrations;  bun run db:generate -- --name <name>  makes a new one
make route-parity         # routes against the Python app's, both ways
make smoke                # the real API, worker and bot on Bun and Node
make script name=demo_user_stats args='...'
make restore-db file=<dump>

bun run web:dev / web:build / web:typecheck / web:lint    # the frontend
bun run build && bun run start:node                      # the Node production build, without Docker
```

## Project Structure

```
gramkit-ts/
├── src/
│   ├── server/        # app.ts, routes.ts, config.ts, modules/<name>/{routes,service,repo,schemas}.ts,
│   │                  # bot/, worker/, scripts/, runtime/ (Node and Bun servers), db/ (Drizzle schema, migrations)
│   └── web/           # the Vue frontend
├── bench/conduit/     # the Conduit benchmark app, built on the same framework
├── docs/              # PORT-PLAN.md (the brief), python-contract/ (routes, schema, API types)
├── nginx/             # default.conf for the frontend container
├── scripts/           # build.ts (esbuild), route-parity, smoke
├── Dockerfile         # backend image, RUNTIME=node|bun
├── Dockerfile.frontend
├── docker-compose.yml       # development: Postgres + Redis
└── docker-compose.prod.yml  # production: the six services
```

`CLAUDE.md` has the conventions (routes, transactions, errors, tests), for people and for Claude Code.
`docs/PORT-PLAN.md` is the brief this port was built from.

## License

MIT, see [LICENSE](LICENSE).
