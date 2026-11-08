import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { TxEnv } from '../env';
import { BadRequestError } from '../lib/errors';

/** Thrown inside the transaction to roll it back. One instance: this is control flow, no stack needed. */
const ROLLBACK = new Error('rollback');

/**
 * Read the whole body before the transaction opens, as FastAPI does: a client that uploads slowly, or stalls, must not
 * hold a connection. `c.req` caches it for the validators and the handler.
 */
async function bufferBody(c: Context<TxEnv>): Promise<void> {
  if (!c.req.header('transfer-encoding') && !(Number(c.req.header('content-length')) > 0)) return;
  try {
    await c.req.arrayBuffer();
  } catch {
    throw new BadRequestError('There was an error parsing the body');
  }
}

/**
 * Run `inner` in the request's transaction: one transaction per request, committed when `inner` ends well, rolled back
 * when it throws or when something downstream failed. Port of Python's `get_repo`.
 *
 * Hono catches what a handler throws and renders it before `await next()` returns here, so a failure shows up as
 * `c.error`, not as an exception. The commit happens before the response leaves: a client that refetches after a 200
 * reads committed data, and a failed commit reaches the client as a 500.
 *
 * Chain it per route, as `Depends(get_services)` is per route: a route with no database work takes no connection.
 * Reentrant, so stacking `getUser` and `getServices` on a route still opens one transaction.
 *
 * A streaming response commits when its handler returns, before the body runs (Python's default too): the stream's
 * body must not use `repos`.
 */
export async function withTransaction<E extends TxEnv>(context: Context<E>, inner: () => Promise<void>): Promise<void> {
  const c = context as unknown as Context<TxEnv>;
  if (c.get('tx')) return inner();

  await bufferBody(c);
  const { db, reposClass } = c.get('state');
  try {
    await db.db.transaction(async (tx) => {
      c.set('tx', tx);
      c.set('repos', new reposClass(tx));
      await inner();
      if (c.error) throw ROLLBACK;
    });
  } catch (err) {
    // With `c.error` set the failure is already rendered and logged; this is its rollback failing (a dead connection).
    if (err !== ROLLBACK && !c.error) throw err;
  }
}

export const transaction = createMiddleware<TxEnv>((c, next) => withTransaction(c, next));
