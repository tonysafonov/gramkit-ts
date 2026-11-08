import { and, count, eq, gte, inArray, isNotNull, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type Friendship, friendships, type NewUser, type User, users } from '../../db/schema';
import { UserNotFoundException } from '../../lib/errors';
import { normalizeEmail } from '../../lib/utils';

/** Columns the caller may set on a user row: everything but the generated ones is optional. */
export type UserValues = Partial<NewUser>;

const firstOrThrow = (rows: User[], userId: string): User => {
  const user = rows[0];
  if (!user) throw new UserNotFoundException(`User ${userId} not found`);
  return user;
};

/** Drops `undefined` and `null`: a missing value must not overwrite the column on conflict. */
const withoutNulls = (data: UserValues): UserValues =>
  Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null));

export class UsersRepo extends BaseRepo<typeof users> {
  constructor(db: Db) {
    super(db, users, users.id);
  }

  /**
   * Creates or updates a user and returns the row. Conflicts on `id` when given, else on `telegram_id`; with neither
   * it is a plain insert. Atomic, so two first requests of the same Telegram user can't both insert.
   */
  async getOrCreateUser(userData: UserValues): Promise<User> {
    const data = withoutNulls(userData);
    const now = sql`CURRENT_TIMESTAMP`;

    if (data.id) {
      const { createdAt: _createdAt, ...set } = data;
      const rows = await this.db
        .insert(users)
        .values(data as NewUser)
        .onConflictDoUpdate({ target: users.id, set: { ...set, updatedAt: now } })
        .returning();
      return firstOrThrow(rows, data.id);
    }
    if (data.telegramId) {
      const { telegramId: _telegramId, id: _id, createdAt: _createdAt, ...set } = data;
      const rows = await this.db
        .insert(users)
        .values(data as NewUser)
        .onConflictDoUpdate({ target: users.telegramId, set: { ...set, updatedAt: now } })
        .returning();
      return firstOrThrow(rows, String(data.telegramId));
    }
    const rows = await this.db
      .insert(users)
      .values(data as NewUser)
      .returning();
    return firstOrThrow(rows, '(new)');
  }

  /** Update and return the row. */
  async updateUser(userId: string, userData: UserValues): Promise<User> {
    const row = await this.update(userId, userData);
    return firstOrThrow(row ? [row] : [], userId);
  }

  /**
   * Atomically merge `patch` into `users.seen_features` via JSONB `||`. The current value is read and written
   * server-side in one UPDATE, so concurrent writes to different top-level keys never lose updates; the same key is
   * last-writer-wins. Record-valued keys are replaced wholesale: callers send the full value.
   */
  async mergeSeenFeatures(userId: string, patch: Record<string, unknown>): Promise<User> {
    const rows = await this.db
      .update(users)
      .set({ seenFeatures: sql`${users.seenFeatures} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(users.id, userId))
      .returning();
    return firstOrThrow(rows, userId);
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.getById(userId);
  }

  /** By app username, case-insensitive. */
  async getByUsername(username: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
    return rows[0] ?? null;
  }

  async getByTgUsername(tgUsername: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.tgUsername, tgUsername));
    return rows[0] ?? null;
  }

  async getByTelegramId(telegramId: number): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.telegramId, telegramId));
    return rows[0] ?? null;
  }

  /** Users a scheduled notification may go to: reachable in Telegram, bot not blocked. */
  private notifiable(): SQL {
    return and(isNotNull(users.telegramId), isNull(users.botBlockedAt), isNotNull(users.timezone)) as SQL;
  }

  /**
   * Notifiable users whose local time (`users.timezone`) is currently `hour`.
   *
   * Postgres `timezone()` raises on an unknown zone name, which would fail the query for every user. Writes are
   * validated (`isValidTimezone`); this guards rows stored before that: an unknown zone is never passed to
   * `timezone()` (CASE) and those users are left out.
   */
  getUsersByLocalTime(hour: number): Promise<User[]> {
    const knownZone = inArray(users.timezone, sql`(select name from pg_timezone_names)`);
    const safeZone = sql`case when ${knownZone} then ${users.timezone} else 'UTC' end`;
    return this.db
      .select()
      .from(users)
      .where(and(this.notifiable(), knownZone, sql`extract(hour from timezone(${safeZone}, now())) = ${hour}`));
  }

  /**
   * Who an all-users broadcast goes to: in Telegram, bot not blocked. Unlike `notifiable()` no timezone is needed: the
   * message goes out right away.
   */
  getBroadcastAudience(): Promise<User[]> {
    return this.db
      .select()
      .from(users)
      .where(and(isNotNull(users.telegramId), isNull(users.botBlockedAt)))
      .orderBy(users.createdAt);
  }

  /** All users `getUsersByLocalTime` can return, whatever their local hour. */
  getNotifiableUsers(): Promise<User[]> {
    return this.db.select().from(users).where(this.notifiable());
  }

  /** Flag the user as having blocked the bot. Keeps the first timestamp and `updated_at`. */
  async markBotBlocked(telegramId: number, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ botBlockedAt: at, updatedAt: sql`${users.updatedAt}` })
      .where(and(eq(users.telegramId, telegramId), isNull(users.botBlockedAt)))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** Drop the blocked flag (the user is back: /start or app open). Keeps `updated_at`. */
  async clearBotBlocked(userId: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ botBlockedAt: null, updatedAt: sql`${users.updatedAt}` })
      .where(and(eq(users.id, userId), isNotNull(users.botBlockedAt)))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async getUsersCount(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(users);
    return row?.value ?? 0;
  }

  async getAllUsersIds(): Promise<string[]> {
    const rows = await this.db.select({ id: users.id }).from(users);
    return rows.map((row) => row.id);
  }

  /** The friendship between two users, in whichever order it was stored. */
  async getFriendship(userId1: string, userId2: string): Promise<Friendship | null> {
    const rows = await this.db
      .select()
      .from(friendships)
      .where(
        or(
          and(eq(friendships.userId1, userId1), eq(friendships.userId2, userId2)),
          and(eq(friendships.userId1, userId2), eq(friendships.userId2, userId1)),
        ),
      );
    return rows[0] ?? null;
  }

  async getFriends(userId: string): Promise<User[]> {
    const rows = await this.db
      .select({ user: users })
      .from(users)
      .innerJoin(
        friendships,
        or(
          and(eq(friendships.userId1, userId), eq(users.id, friendships.userId2)),
          and(eq(friendships.userId2, userId), eq(users.id, friendships.userId1)),
        ),
      )
      .where(eq(friendships.isActive, true));
    return rows.map((row) => row.user);
  }

  /**
   * Add a friendship between two users, stored with the smaller id first. A duplicate raises a unique violation; the
   * insert runs in a savepoint, so the caller can catch it and the request's transaction stays usable.
   */
  async addFriend(userId: string, friendId: string): Promise<boolean> {
    const [userId1, userId2] = userId < friendId ? [userId, friendId] : [friendId, userId];
    await this.db.transaction((tx) => tx.insert(friendships).values({ userId1, userId2 }));
    return true;
  }

  // Statistics -----------------------------------------------------------------------------------------------------

  private async countBetween(column: typeof users.createdAt, from: Date, to: Date = new Date()): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(users)
      .where(and(gte(column, from), lte(column, to)));
    return row?.value ?? 0;
  }

  /** Users created between two dates. */
  getNewUsersCount(from: Date, to?: Date): Promise<number> {
    return this.countBetween(users.createdAt, from, to);
  }

  /** Users updated between two dates. */
  getUpdatedUsersCount(from: Date, to?: Date): Promise<number> {
    return this.countBetween(users.updatedAt, from, to);
  }

  // Email ----------------------------------------------------------------------------------------------------------

  /** The user who verified this email (normalized), if any. */
  async getByVerifiedEmail(email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = ${normalizeEmail(email)}`, eq(users.emailVerified, true)));
    return rows[0] ?? null;
  }

  /** Is the email verified by any user? Prevents duplicate verified emails. */
  async isEmailVerifiedByAnyUser(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${normalizeEmail(email)}`, eq(users.emailVerified, true)))
      .limit(1);
    return rows.length > 0;
  }

  /** By email (normalized), verified or not. */
  async getByEmail(email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`);
    return rows[0] ?? null;
  }
}
