/** Role-based access control. */
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { settings } from '../config';
import type { Database } from '../db/client';
import { UserRole, users } from '../db/schema';
import type { UserEnv } from '../env';
import { ForbiddenError } from '../lib/errors';
import { getLogger } from '../lib/logging';
import { getUser } from './context';

const logger = getLogger('rbac');

/**
 * Lets through users with one of `allowedRoles`, anyone else gets a 403. Includes `getUser`. Telegram ids in
 * `RBAC__OWNER_IDS` always pass, whatever the role in the database says.
 *
 *     .get('/stats', requireRole(UserRole.ADMIN, UserRole.OWNER), (c) => ...)
 */
export const requireRole = (...allowedRoles: UserRole[]) =>
  createMiddleware<UserEnv>((c, next) =>
    getUser(c, async () => {
      const user = c.get('user');
      const isConfiguredOwner = user.telegramId !== null && settings.rbac.ownerIds.includes(user.telegramId);
      if (!isConfiguredOwner && !allowedRoles.includes(user.role as UserRole)) {
        throw new ForbiddenError(`Requires role: [${allowedRoles.map((role) => `'${role}'`).join(', ')}]`);
      }
      await next();
    }),
  );

export const requireAdmin = () => requireRole(UserRole.ADMIN, UserRole.OWNER);
export const requireOwner = () => requireRole(UserRole.OWNER);

export const adminUser = requireAdmin();
export const ownerUser = requireOwner();

/**
 * Sync owner roles from config to the database on startup: promote users in `RBAC__OWNER_IDS`, demote owners who
 * aren't in it.
 */
export async function syncOwnerRoles(db: Database): Promise<void> {
  const { ownerIds } = settings.rbac;
  if (ownerIds.length === 0) {
    logger.info('No RBAC ownerIds configured, skipping role sync');
    return;
  }

  const { promoted, demoted } = await db.transaction(async (tx) => {
    const promotedRows = await tx
      .update(users)
      .set({ role: UserRole.OWNER })
      .where(and(inArray(users.telegramId, ownerIds), ne(users.role, UserRole.OWNER)))
      .returning({ id: users.id });
    const demotedRows = await tx
      .update(users)
      .set({ role: UserRole.USER })
      .where(and(eq(users.role, UserRole.OWNER), notInArray(users.telegramId, ownerIds)))
      .returning({ id: users.id });
    return { promoted: promotedRows.length, demoted: demotedRows.length };
  });

  if (promoted || demoted) logger.info(`RBAC sync: ${promoted} promoted to owner, ${demoted} demoted to user`);
  else logger.info('RBAC roles already in sync');
}
