import { posthog } from '../../clients/posthog';
import type { User } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { UserNotFoundException } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import type { UserValues } from './repo';
import { toUserSchema, type UpdateUserRequest, type UserSchema } from './schemas';

const logger = getLogger('users');

/** Matches `users.referral_code` varchar(40). */
export const MAX_REFERRAL_CODE_LENGTH = 40;

export const DEFAULT_TIMEZONE = 'Europe/Moscow';
/** A "day" starts at 05:00 local, so late-night use counts for the evening before. */
export const STREAK_DAY_START_HOUR = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** An IANA zone name we can resolve. Offsets like `+03:00` are rejected: Intl takes them, tzdata and Postgres' names don't. */
export function isValidTimezone(timezone: string | null | undefined): timezone is string {
  if (!timezone || /^[+-]/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The user's timezone name; Moscow when unset or invalid. */
export function userZoneinfo(timezone: string | null | undefined): string {
  if (isValidTimezone(timezone)) return timezone;
  if (timezone) logger.warn(`Invalid timezone '${timezone}', using ${DEFAULT_TIMEZONE}`);
  return DEFAULT_TIMEZONE;
}

interface WallClock {
  /** The wall-clock reading as if it were UTC: shift by the zone's offset. */
  asUtcMs: number;
  /** Offset from UTC in minutes. */
  offsetMinutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(timezone: string, at: Date): WallClock {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtcMs = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const wholeSecondMs = Math.floor(at.getTime() / 1000) * 1000;
  return { asUtcMs, offsetMinutes: Math.round((asUtcMs - wholeSecondMs) / 60_000) };
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`);

/** `at` as an ISO string in the user's zone with its offset, as Python's `datetime.isoformat()` of an aware datetime. */
export function localIsoformat(timezone: string | null | undefined, at: Date): string {
  const { asUtcMs, offsetMinutes } = wallClock(userZoneinfo(timezone), at);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${new Date(asUtcMs + (at.getTime() % 1000)).toISOString().slice(0, -1)}${offset}`;
}

/**
 * The streak day (`YYYY-MM-DD`) `at` falls on in the user's timezone: days start at 05:00 local.
 *
 * The one definition of "a day" for `users.lastActivityDate`: anything compared with it (e.g. the notification
 * lifecycle stages) must use this.
 */
export function getStreakDay(timezone: string | null | undefined, at: Date): string {
  return isoDay(wallClock(userZoneinfo(timezone), at).asUtcMs - STREAK_DAY_START_HOUR * HOUR_MS);
}

/** Telegram fields that can be updated from the TG API. */
const TG_UPDATABLE_FIELDS = [
  'tgFirstName',
  'tgLastName',
  'tgUsername',
  'tgLanguageCode',
  'tgIsPremium',
  'tgIsBot',
  'tgAddedToAttachmentMenu',
  'tgAllowsWriteToPm',
] as const satisfies readonly (keyof User)[];

export class UsersService extends BaseService {
  /**
   * Get or create a user with as few writes as possible.
   *
   * 1. SELECT the existing user (read-only);
   * 2. exists and no Telegram field changed: return it, no write;
   * 3. exists and some changed: UPDATE only those;
   * 4. doesn't exist: upsert (atomic, so a race is safe).
   *
   * `userData` holds the fields that are set: a key left out is not "unset to null".
   */
  async getOrCreateUser(userData: UserValues): Promise<UserSchema> {
    const telegramId = userData.telegramId;

    if (telegramId) {
      const existing = await this.repos.users.getByTelegramId(telegramId);
      if (existing) {
        const updates = this.getTelegramFieldUpdates(existing, userData);
        if (Object.keys(updates).length === 0) return toUserSchema(existing);
        return toUserSchema(await this.repos.users.updateUser(existing.id, updates));
      }
    }

    return toUserSchema(await this.repos.users.getOrCreateUser(userData));
  }

  /** The Telegram fields of `newData` that differ from the row. */
  private getTelegramFieldUpdates(existing: User, newData: UserValues): UserValues {
    const updates: Record<string, unknown> = {};
    for (const field of TG_UPDATABLE_FIELDS) {
      const value = newData[field];
      if (value !== undefined && existing[field] !== value) updates[field] = value;
    }
    return updates as UserValues;
  }

  async getAll(): Promise<UserSchema[]> {
    return (await this.repos.users.getAll()).map(toUserSchema);
  }

  /** `null` when there is no such user (Python raises a validation error on `None`). */
  async getUserById(userId: string): Promise<UserSchema | null> {
    const user = await this.repos.users.getUserById(userId);
    return user ? toUserSchema(user) : null;
  }

  async getByUsername(username: string): Promise<UserSchema | null> {
    const user = await this.repos.users.getByUsername(username);
    return user ? toUserSchema(user) : null;
  }

  /** By Telegram username. */
  async getByTgUsername(tgUsername: string): Promise<UserSchema | null> {
    const user = await this.repos.users.getByTgUsername(tgUsername);
    return user ? toUserSchema(user) : null;
  }

  /** Notifiable users (Telegram, bot not blocked) whose local hour is `hour`. */
  async getUsersByLocalTime(hour: number): Promise<UserSchema[]> {
    return (await this.repos.users.getUsersByLocalTime(hour)).map(toUserSchema);
  }

  /** Every user a scheduled notification may reach, whatever their local hour. */
  async getNotifiableUsers(): Promise<UserSchema[]> {
    return (await this.repos.users.getNotifiableUsers()).map(toUserSchema);
  }

  /** The user is back (/start or app open): scheduled notifications may reach them again. */
  clearBotBlocked(userId: string): Promise<boolean> {
    return this.repos.users.clearBotBlocked(userId);
  }

  getUsersCount(): Promise<number> {
    return this.repos.users.getUsersCount();
  }

  getAllUsersIds(): Promise<string[]> {
    return this.repos.users.getAllUsersIds();
  }

  /** The user's active friends, as rows with `passwordHash` stripped. */
  async getFriends(userId: string): Promise<UserSchema[]> {
    return (await this.repos.users.getFriends(userId)).map(toUserSchema);
  }

  async addFriend(userId: string, friendId: string): Promise<void> {
    const friend = await this.repos.users.getUserById(friendId);
    if (!friend) throw new UserNotFoundException(`User with id ${friendId} not found`);
    if (await this.isFriend(userId, friendId)) {
      logger.info(`User ${userId} is already friends with ${friendId}`);
      return;
    }
    await this.repos.users.addFriend(userId, friend.id);
  }

  async updateUser(userId: string, userData: UpdateUserRequest): Promise<UserSchema> {
    const updateData: UpdateUserRequest = { ...userData };
    if ('timezone' in updateData && !isValidTimezone(updateData.timezone)) {
      logger.warn(`User ${userId}: ignoring invalid timezone ${JSON.stringify(updateData.timezone)}`);
      delete updateData.timezone;
    }
    if ('isOnboarded' in updateData) posthog.capture(userId, 'user_onboarded');

    const current = await this.repos.users.getUserById(userId);
    if (!current) throw new UserNotFoundException(`User ${userId} not found`);

    return toUserSchema(await this.repos.users.updateUser(userId, updateData));
  }

  /** By Telegram id, for admin operations. */
  async getByTelegramId(telegramId: number): Promise<UserSchema | null> {
    const user = await this.repos.users.getByTelegramId(telegramId);
    return user ? toUserSchema(user) : null;
  }

  /**
   * Merge feature-seen flags into the user's `seenFeatures` map. A generic primitive for one-time reveals,
   * coachmarks, "what's new" and capped nudges: gating state only, written via the dedicated endpoint.
   */
  async mergeSeenFeatures(userId: string, patch: Record<string, unknown>): Promise<UserSchema> {
    return toUserSchema(await this.repos.users.mergeSeenFeatures(userId, patch));
  }

  async isFriend(userId1: string, userId2: string): Promise<boolean> {
    const friendship = await this.repos.users.getFriendship(userId1, userId2);
    return friendship?.isActive === true;
  }

  /** Save the referral code for acquisition tracking. First touch wins. */
  async processReferral(referralId: string, userId: string): Promise<void> {
    // Guard against empty/whitespace payloads (a bare /start).
    const code = referralId ? referralId.trim() : '';
    if (!code) return;
    // The /start payload allows up to 64 chars but referral_code is varchar(40): storing a longer value would crash
    // the handler. Legit codes are short (`r-123456`), so an over-long one is garbage: skip it, onboarding goes on.
    if (code.length > MAX_REFERRAL_CODE_LENGTH) {
      logger.warn(
        `User ${userId}: referral code too long (${code.length} > ${MAX_REFERRAL_CODE_LENGTH}), skipping: ${JSON.stringify(code.slice(0, 64))}`,
      );
      return;
    }

    const user = await this.repos.users.getUserById(userId);
    if (!user) {
      logger.warn(`User ${userId} not found`);
      return;
    }
    if (user.referralCode) {
      logger.info(`User ${userId} already registered with referral code: ${user.referralCode}`);
      return;
    }

    await this.repos.users.updateUser(userId, { referralCode: code });
    logger.info(`User ${userId}: Referral code saved: ${code}`);
  }

  /** Deprecated: use `processReferral`. */
  processReferal(referalId: string, userId: string): Promise<void> {
    return this.processReferral(referalId, userId);
  }

  /**
   * Update the user's streak when they use the app (called from `processStart`). A new day starts at 5 AM local time
   * (Moscow when unset), so late-night use doesn't break streaks.
   */
  async updateUserStreak(userId: string): Promise<UserSchema | null> {
    const user = await this.repos.users.getUserById(userId);
    if (!user) {
      logger.error(`User ${userId} not found for streak update`);
      return null;
    }

    // Opening the app means the user is reachable again (see botBlockedAt)
    if (user.botBlockedAt !== null) await this.repos.users.clearBotBlocked(userId);

    const userTimezone = user.timezone || DEFAULT_TIMEZONE;
    const now = new Date();
    const streakDay = getStreakDay(user.timezone, now);

    // Fix legacy users with streak 0
    let currentStreak = user.currentStreak;
    if (currentStreak === 0) {
      logger.warn(`User ${userId} has streak 0, fixing to 1`);
      currentStreak = 1;
    }

    // Already processed this streak day
    if (user.lastActivityDate === streakDay) {
      if (user.currentStreak === 0) {
        const fixed = await this.repos.users.updateUser(userId, {
          currentStreak: Math.max(currentStreak, 1),
          bestStreak: Math.max(user.bestStreak, 1),
          totalActiveDays: Math.max(user.totalActiveDays, 1),
        });
        return toUserSchema(fixed);
      }
      return toUserSchema(user);
    }

    let newCurrentStreak: number;
    let newTotalActiveDays: number;
    if (!user.lastActivityDate) {
      newCurrentStreak = 1;
      newTotalActiveDays = Math.max(user.totalActiveDays, 1);
    } else if (user.lastActivityDate === isoDay(dayMs(streakDay) - DAY_MS)) {
      newCurrentStreak = currentStreak + 1;
      newTotalActiveDays = user.totalActiveDays + 1;
    } else {
      newCurrentStreak = 1;
      newTotalActiveDays = user.totalActiveDays + 1;
      const daysGap = Math.round((dayMs(streakDay) - dayMs(user.lastActivityDate)) / DAY_MS);
      if (daysGap > 1) logger.info(`User ${userId}: Streak reset after ${daysGap} day gap`);
    }

    const newBestStreak = Math.max(user.bestStreak, newCurrentStreak);

    // Values are never 0
    newCurrentStreak = Math.max(newCurrentStreak, 1);
    newTotalActiveDays = Math.max(newTotalActiveDays, 1);

    let updated: User;
    try {
      updated = await this.repos.users.updateUser(userId, {
        currentStreak: newCurrentStreak,
        bestStreak: Math.max(newBestStreak, 1),
        lastActivityDate: streakDay,
        totalActiveDays: newTotalActiveDays,
      });
    } catch (err) {
      logger.error({ err }, `User ${userId}: Streak update failed - ${err instanceof Error ? err.message : err}`);
      // Return the user with at least streak 1 so the client never shows 0
      if (user.currentStreak === 0) {
        return toUserSchema({
          ...user,
          currentStreak: 1,
          bestStreak: Math.max(user.bestStreak, 1),
          totalActiveDays: Math.max(user.totalActiveDays, 1),
        });
      }
      return toUserSchema(user);
    }

    // Streak milestones, for analytics
    if ([3, 7, 14, 30, 100].includes(newCurrentStreak)) {
      posthog.capture(userId, 'streak_milestone_reached', {
        streak_days: newCurrentStreak,
        is_new_best: newCurrentStreak === Math.max(newBestStreak, 1),
        user_timezone: userTimezone,
        streak_day: streakDay,
        local_time: localIsoformat(user.timezone, now),
      });
    }

    return toUserSchema(updated);
  }

  /**
   * Reset the streak to 1 (for fixing broken streaks). Without `force`, a user who already has a streak is left alone.
   */
  async resetUserStreak(userId: string, force = false): Promise<UserSchema | null> {
    const user = await this.repos.users.getUserById(userId);
    if (!user) {
      logger.warn(`User ${userId} not found for streak reset`);
      return null;
    }

    if (!force && user.currentStreak > 0) {
      logger.info(`User ${userId} already has streak ${user.currentStreak}, skipping reset`);
      return toUserSchema(user);
    }

    const streakDay = getStreakDay(user.timezone, new Date());
    const updated = await this.repos.users.updateUser(userId, {
      currentStreak: 1,
      bestStreak: Math.max(user.bestStreak, 1),
      lastActivityDate: streakDay,
      totalActiveDays: Math.max(user.totalActiveDays, 1),
    });

    logger.info(`User ${userId}: Streak manually reset to 1 (was ${user.currentStreak})`);
    return toUserSchema(updated);
  }
}
