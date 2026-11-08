import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserType, users } from '../../db/schema';
import { UserNotFoundException } from '../../lib/errors';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { getStreakDay, isValidTimezone, MAX_REFERRAL_CODE_LENGTH, userZoneinfo } from './service';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** A request's worth of repos and services: one transaction, rolled back at the end. */
async function inTransaction<T>(fn: (services: Services, repos: Repos) => Promise<T>): Promise<T> {
  const rollback = new Error('rollback');
  let result: T | undefined;
  try {
    await t.db.transaction(async (tx) => {
      const repos = new Repos(tx);
      const services = new Services(repos, t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);
      result = await fn(services, repos);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  return result as T;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

describe('seen_features merge (atomic JSONB ||)', () => {
  it('defaults to empty', async () => {
    const user = await createUser(t.db);
    await inTransaction(async (services) => {
      expect((await services.users.getUserById(user.id))?.seenFeatures).toEqual({});
    });
  });

  it('adds a key', async () => {
    const user = await createUser(t.db);
    await inTransaction(async (services) => {
      const updated = await services.users.mergeSeenFeatures(user.id, { 'reveal.profile_tab': true });
      expect(updated.seenFeatures).toEqual({ 'reveal.profile_tab': true });
    });
  });

  it('preserves other keys', async () => {
    // The core guarantee: a later merge must not clobber an earlier key.
    const user = await createUser(t.db);
    await inTransaction(async (services) => {
      await services.users.mergeSeenFeatures(user.id, { 'reveal.profile_tab': true });
      const updated = await services.users.mergeSeenFeatures(user.id, { 'whatsnew.dashboard': { v: 2 } });
      expect(updated.seenFeatures).toEqual({ 'reveal.profile_tab': true, 'whatsnew.dashboard': { v: 2 } });
    });
  });

  it('overwrites the same key wholesale', async () => {
    // Record-valued keys are replaced as a unit (callers send the full value).
    const user = await createUser(t.db);
    await inTransaction(async (services) => {
      await services.users.mergeSeenFeatures(user.id, { 'nudge.push_optin': { n: 1, at: '2026-06-01T00:00:00Z' } });
      const updated = await services.users.mergeSeenFeatures(user.id, {
        'nudge.push_optin': { n: 2, at: '2026-06-08T00:00:00Z', ack: 'dismissed' },
      });
      expect(updated.seenFeatures['nudge.push_optin']).toEqual({ n: 2, at: '2026-06-08T00:00:00Z', ack: 'dismissed' });
    });
  });

  it('does not lose concurrent writes to different keys', async () => {
    const user = await createUser(t.db);
    const repos = new Repos(t.db);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => repos.users.mergeSeenFeatures(user.id, { [`reveal.k${i}`]: true })),
    );
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(Object.keys(row?.seenFeatures ?? {})).toHaveLength(10);
  });
});

describe('referral code (regression: an over-long /start payload crashed the handler)', () => {
  const persisted = async (id: string) => (await t.db.select().from(users).where(eq(users.id, id)))[0]?.referralCode;

  it('does not crash or persist a 41+ char code', async () => {
    const user = await createUser(t.db, { referralCode: null });
    await inTransaction(async (services) => {
      await services.users.processReferral('a'.repeat(MAX_REFERRAL_CODE_LENGTH + 1), user.id);
      expect((await services.users.getUserById(user.id))?.referralCode).toBeNull();
    });
    expect(await persisted(user.id)).toBeNull();
  });

  it('stores a normal code', async () => {
    const user = await createUser(t.db, { referralCode: null });
    await inTransaction(async (services) => {
      await services.users.processReferral('r-123456', user.id);
      expect((await services.users.getUserById(user.id))?.referralCode).toBe('r-123456');
    });
  });

  it('stores a code of exactly 40 chars, trimmed', async () => {
    const user = await createUser(t.db, { referralCode: null });
    const code = 'b'.repeat(MAX_REFERRAL_CODE_LENGTH);
    await inTransaction(async (services) => {
      await services.users.processReferral(`  ${code}  `, user.id);
      expect((await services.users.getUserById(user.id))?.referralCode).toBe(code);
    });
  });

  it('ignores an empty or whitespace payload', async () => {
    const user = await createUser(t.db, { referralCode: null });
    await inTransaction(async (services) => {
      await services.users.processReferral('   ', user.id);
      await services.users.processReferral('', user.id);
      expect((await services.users.getUserById(user.id))?.referralCode).toBeNull();
    });
  });

  it('does not overwrite an existing code: the first attribution wins', async () => {
    const user = await createUser(t.db, { referralCode: null });
    await inTransaction(async (services) => {
      await services.users.processReferral('r-111', user.id);
      await services.users.processReferral('r-222', user.id);
      expect((await services.users.getUserById(user.id))?.referralCode).toBe('r-111');
    });
  });
});

describe('getOrCreateUser', () => {
  it('is idempotent for one Telegram id', async () => {
    await inTransaction(async (services) => {
      const first = await services.users.getOrCreateUser({
        telegramId: 5_550_001,
        username: 'idempotent_test',
        tgFirstName: 'Test',
      });
      const second = await services.users.getOrCreateUser({
        telegramId: 5_550_001,
        username: 'idempotent_test',
        tgFirstName: 'Test',
      });
      expect(second.id).toBe(first.id);
      expect(second.telegramId).toBe(5_550_001);
      expect(second.updatedAt).toEqual(first.updatedAt); // no write on the fast path
    });
  });

  it('updates only the changed Telegram fields', async () => {
    await inTransaction(async (services) => {
      const first = await services.users.getOrCreateUser({
        telegramId: 5_550_002,
        tgFirstName: 'Old',
        tgIsPremium: false,
      });
      const second = await services.users.getOrCreateUser({
        telegramId: 5_550_002,
        tgFirstName: 'New',
        username: 'ignored_here',
      });
      expect(second.id).toBe(first.id);
      expect(second.tgFirstName).toBe('New');
      expect(second.username).toBe(first.username);
    });
  });

  it('never returns the password hash', async () => {
    const user = await createUser(t.db, { passwordHash: 'secret' });
    await inTransaction(async (services) => {
      const found = await services.users.getByTelegramId(user.telegramId as number);
      expect(found).not.toBeNull();
      expect(found).not.toHaveProperty('passwordHash');
    });
  });

  it('applies the column defaults to a new user', async () => {
    await inTransaction(async (services) => {
      const created = await services.users.getOrCreateUser({ telegramId: 5_550_003 });
      expect(created.userType).toBe(UserType.REGISTERED);
      expect(created.timezone).toBe('Europe/Moscow');
      expect(created.currentStreak).toBe(0);
      expect(created.seenFeatures).toEqual({});
      expect(created.lastActivityDate).toBeNull();
    });
  });
});

describe('updateUser', () => {
  it('ignores an invalid timezone and keeps the rest', async () => {
    const user = await createUser(t.db, { timezone: 'UTC' });
    await inTransaction(async (services) => {
      const updated = await services.users.updateUser(user.id, { timezone: 'Mars/Phobos', displayName: 'Z' });
      expect(updated.timezone).toBe('UTC');
      expect(updated.displayName).toBe('Z');
    });
  });

  it('with nothing left to update still returns the user', async () => {
    const user = await createUser(t.db);
    await inTransaction(async (services) => {
      const updated = await services.users.updateUser(user.id, { timezone: 'nope' });
      expect(updated.id).toBe(user.id);
    });
  });

  it('throws UserNotFoundException for an unknown user', async () => {
    await inTransaction(async (services) => {
      await expect(
        services.users.updateUser('00000000-0000-4000-8000-000000000000', { displayName: 'x' }),
      ).rejects.toBeInstanceOf(UserNotFoundException);
    });
  });

  it('captures user_onboarded when is_onboarded is sent', async () => {
    const user = await createUser(t.db);
    const before = t.fakes.posthog.events.length;
    await inTransaction((services) => services.users.updateUser(user.id, { isOnboarded: true }));
    expect(t.fakes.posthog.events.slice(before).map((e) => e.event)).toEqual(['user_onboarded']);
  });
});

describe('streak day (a day starts at 05:00 local)', () => {
  const moscow = (iso: string) => getStreakDay('Europe/Moscow', new Date(iso));

  it('10 AM is the same day', () => expect(moscow('2025-08-30T10:00:00+03:00')).toBe('2025-08-30'));
  it('2 AM is the previous day', () => expect(moscow('2025-08-30T02:00:00+03:00')).toBe('2025-08-29'));
  it('exactly 5 AM is the current day', () => expect(moscow('2025-08-30T05:00:00+03:00')).toBe('2025-08-30'));
  it('4:59 AM is the previous day', () => expect(moscow('2025-08-30T04:59:00+03:00')).toBe('2025-08-29'));
  it('midnight is the previous day', () => expect(moscow('2025-08-30T00:00:00+03:00')).toBe('2025-08-29'));
  it('11 PM is the same day', () => expect(moscow('2025-08-30T23:00:00+03:00')).toBe('2025-08-30'));

  it('follows the user timezone', () => {
    const at = new Date('2025-08-30T01:00:00Z');
    expect(getStreakDay('UTC', at)).toBe('2025-08-29');
    expect(getStreakDay('Asia/Tokyo', at)).toBe('2025-08-30');
  });

  it('falls back to Moscow for an invalid or unset timezone', () => {
    const at = new Date('2025-08-30T10:00:00+03:00');
    expect(getStreakDay('Invalid/Timezone', at)).toBe('2025-08-30');
    expect(getStreakDay(null, new Date('2025-08-30T02:00:00+03:00'))).toBe('2025-08-29');
    expect(userZoneinfo(undefined)).toBe('Europe/Moscow');
  });

  it('validates timezone names', () => {
    expect(isValidTimezone('Europe/Moscow')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    expect(isValidTimezone('+03:00')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
  });
});

describe('streak update', () => {
  const streakUser = (overrides = {}) => createUser(t.db, { timezone: 'UTC', ...overrides });
  const today = () => getStreakDay('UTC', new Date());
  const daysAgo = (n: number) => isoDay(new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000));

  it('first time user gets streak 1', async () => {
    const user = await streakUser();
    await inTransaction(async (services) => {
      const updated = await services.users.updateUserStreak(user.id);
      expect(updated?.currentStreak).toBe(1);
      expect(updated?.bestStreak).toBe(1);
      expect(updated?.totalActiveDays).toBe(1);
      expect(updated?.lastActivityDate).toBe(today());
    });
  });

  it('a second call on the same day changes nothing', async () => {
    const user = await streakUser();
    await inTransaction(async (services) => {
      await services.users.updateUserStreak(user.id);
      const again = await services.users.updateUserStreak(user.id);
      expect(again?.currentStreak).toBe(1);
      expect(again?.totalActiveDays).toBe(1);
    });
  });

  it('a consecutive day increments the streak', async () => {
    const user = await streakUser({
      lastActivityDate: daysAgo(1),
      currentStreak: 5,
      bestStreak: 5,
      totalActiveDays: 5,
    });
    await inTransaction(async (services) => {
      const updated = await services.users.updateUserStreak(user.id);
      expect(updated?.currentStreak).toBe(6);
      expect(updated?.bestStreak).toBe(6);
      expect(updated?.totalActiveDays).toBe(6);
    });
  });

  it('a gap resets the streak, keeps the best, counts the day', async () => {
    const user = await streakUser({
      lastActivityDate: daysAgo(3),
      currentStreak: 4,
      bestStreak: 9,
      totalActiveDays: 10,
    });
    await inTransaction(async (services) => {
      const updated = await services.users.updateUserStreak(user.id);
      expect(updated?.currentStreak).toBe(1);
      expect(updated?.bestStreak).toBe(9);
      expect(updated?.totalActiveDays).toBe(11);
    });
  });

  it('streak never goes below 1 (legacy streak 0)', async () => {
    const user = await streakUser({ currentStreak: 0 });
    await inTransaction(async (services) => {
      const updated = await services.users.updateUserStreak(user.id);
      expect(updated?.currentStreak).toBeGreaterThanOrEqual(1);
    });
  });

  it('fixes streak 0 when the day was already processed', async () => {
    const user = await streakUser({ currentStreak: 0, bestStreak: 0, totalActiveDays: 0, lastActivityDate: today() });
    await inTransaction(async (services) => {
      const updated = await services.users.updateUserStreak(user.id);
      expect(updated).toMatchObject({ currentStreak: 1, bestStreak: 1, totalActiveDays: 1 });
    });
  });

  it('works for Moscow, UTC and an invalid timezone', async () => {
    for (const timezone of ['Europe/Moscow', 'UTC', 'Invalid/Timezone']) {
      const user = await streakUser({ timezone });
      await inTransaction(async (services) => {
        expect(await services.users.updateUserStreak(user.id)).not.toBeNull();
      });
    }
  });

  it('returns null for an unknown user', async () => {
    await inTransaction(async (services) => {
      expect(await services.users.updateUserStreak('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });

  it('clears bot_blocked_at when the user opens the app', async () => {
    const user = await streakUser({ botBlockedAt: new Date() });
    await inTransaction(async (services, repos) => {
      await services.users.updateUserStreak(user.id);
      expect((await repos.users.getById(user.id))?.botBlockedAt).toBeNull();
    });
  });

  it('captures a milestone at 3 days', async () => {
    const user = await streakUser({
      lastActivityDate: daysAgo(1),
      currentStreak: 2,
      bestStreak: 2,
      totalActiveDays: 2,
    });
    const before = t.fakes.posthog.events.length;
    await inTransaction((services) => services.users.updateUserStreak(user.id));
    const event = t.fakes.posthog.events.slice(before).find((e) => e.event === 'streak_milestone_reached');
    expect(event?.properties).toMatchObject({ streak_days: 3, is_new_best: true, user_timezone: 'UTC' });
  });
});

describe('streak reset', () => {
  it('force sets it to 1', async () => {
    const user = await createUser(t.db, { currentStreak: 0 });
    await inTransaction(async (services) => {
      expect((await services.users.resetUserStreak(user.id, true))?.currentStreak).toBe(1);
    });
  });

  it('preserves a higher best streak', async () => {
    const user = await createUser(t.db, { currentStreak: 50, bestStreak: 50 });
    await inTransaction(async (services) => {
      const updated = await services.users.resetUserStreak(user.id, true);
      expect(updated).toMatchObject({ currentStreak: 1, bestStreak: 50 });
    });
  });

  it('without force leaves a live streak alone', async () => {
    const user = await createUser(t.db, { currentStreak: 7, bestStreak: 7 });
    await inTransaction(async (services) => {
      expect((await services.users.resetUserStreak(user.id))?.currentStreak).toBe(7);
    });
  });
});

describe('friends', () => {
  it('addFriend stores one mutual friendship; getFriends sees it from both sides', async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    await inTransaction(async (services) => {
      await services.users.addFriend(a.id, b.id);
      await services.users.addFriend(b.id, a.id); // already friends: no-op
      expect((await services.users.getFriends(a.id)).map((u) => u.id)).toEqual([b.id]);
      expect((await services.users.getFriends(b.id)).map((u) => u.id)).toEqual([a.id]);
      expect(await services.users.isFriend(a.id, b.id)).toBe(true);
      expect(await services.users.isFriend(b.id, a.id)).toBe(true);
    });
  });

  it('addFriend throws UserNotFoundException for an unknown friend', async () => {
    const a = await createUser(t.db);
    await inTransaction(async (services) => {
      await expect(services.users.addFriend(a.id, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
        UserNotFoundException,
      );
    });
  });
});

describe('lookups', () => {
  it('finds by username case-insensitively, by tg username and by telegram id', async () => {
    const user = await createUser(t.db, { username: 'MixedCase_x1', tgUsername: 'tg_lookup_x1' });
    await inTransaction(async (services) => {
      expect((await services.users.getByUsername('mixedcase_X1'))?.id).toBe(user.id);
      expect((await services.users.getByTgUsername('tg_lookup_x1'))?.id).toBe(user.id);
      expect((await services.users.getByTelegramId(user.telegramId as number))?.id).toBe(user.id);
      expect(await services.users.getByUsername('nobody_here_x1')).toBeNull();
    });
  });

  it('notifiable users: Telegram, not blocked, with a timezone; by local hour', async () => {
    const hourIn = (tz: string) =>
      Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    const reachable = await createUser(t.db, { timezone: 'UTC' });
    const blocked = await createUser(t.db, { timezone: 'UTC', botBlockedAt: new Date() });
    const web = await createUser(t.db, { timezone: 'UTC', telegramId: null });
    const garbage = await createUser(t.db, { timezone: 'Not/AZone' });
    await inTransaction(async (services) => {
      const all = (await services.users.getNotifiableUsers()).map((u) => u.id);
      expect(all).toContain(reachable.id);
      expect(all).not.toContain(blocked.id);
      expect(all).not.toContain(web.id);
      const atHour = (await services.users.getUsersByLocalTime(hourIn('UTC'))).map((u) => u.id);
      expect(atHour).toContain(reachable.id);
      expect(atHour).not.toContain(garbage.id); // an unknown zone doesn't fail the query
      expect((await services.users.getUsersByLocalTime((hourIn('UTC') + 1) % 24)).map((u) => u.id)).not.toContain(
        reachable.id,
      );
    });
  });

  it('markBotBlocked keeps the first timestamp and updated_at; clearBotBlocked drops it', async () => {
    const user = await createUser(t.db);
    const repos = new Repos(t.db);
    const first = new Date('2026-01-01T00:00:00Z');
    expect(await repos.users.markBotBlocked(user.telegramId as number, first)).toBe(true);
    expect(await repos.users.markBotBlocked(user.telegramId as number, new Date())).toBe(false);
    const [blocked] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(blocked?.botBlockedAt).toEqual(first);
    expect(blocked?.updatedAt).toEqual(user.updatedAt);
    expect(await repos.users.clearBotBlocked(user.id)).toBe(true);
    expect(await repos.users.clearBotBlocked(user.id)).toBe(false);
  });

  it('finds users by verified email, normalized', async () => {
    const user = await createUser(t.db, { email: 'Verified.One@Example.com', emailVerified: true });
    await createUser(t.db, { email: 'unverified.one@example.com', emailVerified: false });
    const repos = new Repos(t.db);
    expect((await repos.users.getByVerifiedEmail('  verified.one@example.COM '))?.id).toBe(user.id);
    expect(await repos.users.getByVerifiedEmail('unverified.one@example.com')).toBeNull();
    expect((await repos.users.getByEmail('unverified.one@example.com'))?.emailVerified).toBe(false);
    expect(await repos.users.isEmailVerifiedByAnyUser('verified.one@example.com')).toBe(true);
    expect(await repos.users.isEmailVerifiedByAnyUser('unverified.one@example.com')).toBe(false);
  });
});
