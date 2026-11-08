import type { MiddlewareFn } from 'grammy';
import type { Database } from '../../db/client';
import { Repos } from '../../repos';
import type { BotContext } from '../context';

/** One transaction per update: committed when the handlers return, rolled back when one throws. */
export function databaseMiddleware(
  db: Database,
  reposClass: new (db: Database) => Repos = Repos,
): MiddlewareFn<BotContext> {
  return (ctx, next) =>
    db.transaction(async (tx) => {
      ctx.repos = new reposClass(tx as never);
      await next();
    });
}
