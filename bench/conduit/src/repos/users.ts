import { and, eq, exists, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../../../../src/server/db/client';
import { BaseRepo } from '../../../../src/server/db/repo/base';
import { follows, users } from '../db/schema';

const USER_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  bio: users.bio,
  image: users.image,
};

/** `coalesce($1::text, column)`: a field that is absent or `null` stays as it is. */
export const coalesceText = (value: string | null | undefined, column: AnyPgColumn): SQL<string> =>
  sql`coalesce(${value ?? null}::text, ${column})`;

/** EXISTS (SELECT 1 FROM follows WHERE follower_id = viewer AND followee_id = <followeeId>). */
export const followingExpr = (db: Db, viewer: number, followeeId: AnyPgColumn): SQL<boolean> =>
  exists(
    db
      .select({ one: sql`1` })
      .from(follows)
      .where(and(eq(follows.followerId, viewer), eq(follows.followeeId, followeeId))),
  ) as SQL<boolean>;

export class UsersRepo extends BaseRepo<typeof users> {
  constructor(db: Db) {
    super(db, users, users.id);
  }

  async register(username: string, email: string, passwordHash: string) {
    const rows = await this.db.insert(users).values({ username, email, passwordHash }).returning(USER_COLUMNS);
    return rows[0] as NonNullable<(typeof rows)[0]>;
  }

  async getForLogin(email: string) {
    const rows = await this.db
      .select({ ...USER_COLUMNS, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email));
    return rows[0] ?? null;
  }

  async getRow(userId: number) {
    const rows = await this.db.select(USER_COLUMNS).from(users).where(eq(users.id, userId));
    return rows[0] ?? null;
  }

  async updateFields(
    userId: number,
    email: string | null | undefined,
    username: string | null | undefined,
    passwordHash: string | null,
    bio: string | null | undefined,
    image: string | null | undefined,
  ) {
    const rows = await this.db
      .update(users)
      .set({
        email: coalesceText(email, users.email),
        username: coalesceText(username, users.username),
        passwordHash: coalesceText(passwordHash, users.passwordHash),
        bio: coalesceText(bio, users.bio),
        image: coalesceText(image, users.image),
      })
      .where(eq(users.id, userId))
      .returning(USER_COLUMNS);
    return rows[0] ?? null;
  }

  async getProfile(viewer: number, username: string) {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        bio: users.bio,
        image: users.image,
        following: followingExpr(this.db, viewer, users.id),
      })
      .from(users)
      .where(eq(users.username, username));
    return rows[0] ?? null;
  }

  async getByUsername(username: string) {
    const rows = await this.db
      .select({ id: users.id, username: users.username, bio: users.bio, image: users.image })
      .from(users)
      .where(eq(users.username, username));
    return rows[0] ?? null;
  }

  async follow(followerId: number, followeeId: number): Promise<void> {
    await this.db.insert(follows).values({ followerId, followeeId }).onConflictDoNothing();
  }

  async unfollow(followerId: number, followeeId: number): Promise<void> {
    await this.db.delete(follows).where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)));
  }
}
