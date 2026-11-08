# Overlay: prepared

The one change: the hot repo queries end in Drizzle's `.prepare('name').execute()` instead of being awaited directly.
Everything else (layers, one transaction per request, the SQL itself) stays as it is, so this step can be measured
on its own:

```bash
OVERLAYS=prepared bench/conduit/push.sh root@<target> gramkit-ts-node-prepared
OVERLAYS=prepared bench/conduit/push.sh root@<target> gramkit-ts-bun-prepared
```

Why it is its own step: a query builder awaited directly reaches postgres.js with `prepare: false`, an unnamed
statement Postgres parses and plans on every execution, whatever `prepare: true` says on the client (see
`node_modules/drizzle-orm/postgres-js/session.js`: `name !== undefined`). `.prepare('name')` is what turns on postgres.js' per-connection
statement cache, which is what SQLAlchemy on asyncpg does by default.

This is the documented API with one deviation from the docs' example, which builds `db.select()...prepare('x')` once at
module level with `sql.placeholder()`. A prepared query is bound to the client it was built on, and here that has to be
the request's transaction, or it would run outside it. So each request builds the query on its `tx` and prepares it
there: the query builder's work stays, and only the server-side parse and plan go. The name is only a flag for
postgres.js, which keys its cache on the statement text.

Covered: every query the load generator's page mix runs at a meaningful rate (the lists and their counts, the feed, the
article and comment reads, profiles, `GET /api/user`, login, favorite and follow toggles, adding and deleting a
comment, tags). Left as they are: register, `PUT /api/user`, publishing and editing an article. They are rare, and
`addTags`' statement text changes with the number of tags.

The change is `prepared.patch` against `src/repos/`; `push.sh` applies it to the staged copy and fails if it no longer
applies.
