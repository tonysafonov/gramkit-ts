# conduit-bench: gramkit on Arjay's multicore benchmark

> **In this repo:** a copy of the Python gramkit bench, so both sides of the comparison are reproducible. It builds
> from a [gramkit](https://github.com/tonysafonov/gramkit) checkout: copy this folder to `apps/conduit-bench/` there and
> run `apps/conduit-bench/push.sh` (it ships the checkout's `core/` and pins from its `uv.lock`). The TypeScript twin is
> [`../conduit/`](../conduit/); results of both: [`docs/benchmarks/`](../../docs/benchmarks/).

**Front: nginx.**

The [RealWorld "Conduit"](https://github.com/gothinkster/realworld) API from Arjay McCandless's
[multicore server challenge](https://github.com/arjaythedev/multicore-server-challenge) (`SPEC.md`, 19 endpoints),
built the way a gramkit app is built, so the challenge's load generator measures **gramkit's own overhead**
against the challenge's plain FastAPI example on the same box.

What is gramkit here, as an app built from today's template (ported 2026-11-06; the 2026-11-01 runs used the
older template, see `docs/tasks/gramkit-perf/README.md`):

- `create_api` from core: its lifespan (one aiogram `Bot` and one arq pool per process, `gc.freeze()` after
  startup), the pure-ASGI middleware stack (request id, request tracker, security headers, CORS, one access-log
  line per request), rate-limiter state and global error handler; logging (written from a listener thread),
  Logfire and PostHog setup;
- the request dependencies are core's, re-exported by `webhook/dependencies/*` exactly as in template-vue:
  one SQLAlchemy session and transaction per request (core's engine: `pool_size=10, max_overflow=10`,
  `pool_pre_ping=True`), and core's `get_services` building the app's `RequestsService`
  (`create_api(services_class=...)`) from the process-wide Bot / arq pool / Redis client. No `dependency_overrides`;
- repos on SQLAlchemy, services on core's `BaseService`, aggregators composed like the templates' `RequestsRepo` /
  `RequestsService`, Pydantic response models;
- the templates' uvicorn command: `--workers 1 --no-access-log --timeout-keep-alive 95`.

What the spec forces, and so differs from a template app: JWT auth (`Authorization: Token`, `webhook/auth.py`)
instead of Telegram initData / session cookies (Conduit's own dependency for its own routes; core's `get_user`
is untouched), and one error shape (`{"errors": {"body": [...]}}`) for every
error via handlers (`webhook/errors.py`). The slowapi rate limit isn't applied to these routes. Not eligible for
the challenge's leaderboard: rule 2 forbids Redis.

## Layout on the box

`push.sh` assembles `/opt/challenge/subs/<name>/`: `install.sh` (root: Redis, uv 0.13.0, CPython 3.14; uv 0.13.0
installs 3.14.8, the templates' Docker images pin 3.14.10),
`build.sh` (venv from `requirements.txt` = gramkit's `uv.lock` exported for template-vue, plus `bcrypt==5.0.0`),
`start.sh`, `core/` (core/backend/src), `app/` (backend/src), optional `tuning.env`, and `GIT_HEAD`.

## Run

```bash
apps/conduit-bench/push.sh root@<target> gramkit-conduit          # copy, install, build on the box
ssh root@<target> /opt/conduit-tools/switch.sh gramkit-conduit   # conformance, fresh DB, start
# then from the load box: conduit-loadgen search -target-ssh root@<target> -lang gramkit-conduit ...
```

Tuning steps: put `WORKERS=...` / `DB__POOL_SIZE=...` / `UVICORN_EXTRA=...` in a file and pass it as
`TUNING_ENV=<file>` to `push.sh` under another name (`tuning/workers2-pool10.env`: 2 workers, 10 connections each).
`overlays/` holds the 2026-11-01 fix ladder against the old template; those fixes are in core now, so don't
apply them to this version.
Notes and results: `docs/tasks/gramkit-perf/`.
