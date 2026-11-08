/**
 * AdminUsersRepo against real PostgreSQL: the role / user_type filters, search, the sort whitelist fallback, the
 * per-user sub-lists, and the active-subscription definition used by the detail page. Rows carry a per-test marker in
 * the username, and searches are scoped to it. Port of `tests/integration/repositories/test_admin_users_repo.py`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PaymentProvider,
  PaymentStatus,
  payments,
  SubscriptionStatus,
  subscriptions,
  type User,
  UserRole,
  UserType,
} from '../../db/schema';
import { Repos } from '../../repos';
import { createTestApp, createUser, type TestApp } from '../../testing';
import type { AdminListParams } from './schemas';

let t: TestApp;
let repo: Repos['adminUsers'];

beforeAll(async () => {
  t = await createTestApp();
  repo = new Repos(t.db).adminUsers;
});
afterAll(() => t.close());

const params = (overrides: Partial<AdminListParams> = {}): AdminListParams => ({
  page: 1,
  pageSize: 25,
  sortDir: 'desc',
  ...overrides,
});
const marker = () => `m${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const seedUser = (
  mark: string,
  {
    role = UserRole.USER,
    userType = UserType.REGISTERED,
    suffix,
  }: { role?: string; userType?: UserType; suffix?: string } = {},
): Promise<User> => createUser(t.db, { username: `${mark}_${suffix ?? randomUUID().slice(0, 6)}`, role, userType });

async function seedSubscription(user: User, status: SubscriptionStatus, endInDays: number) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const [sub] = await t.db
    .insert(subscriptions)
    .values({
      userId: user.id,
      productId: 'TEST_SUB',
      providerId: PaymentProvider.GIFT,
      status,
      currency: 'RUB',
      startDate: new Date(now - 30 * day),
      endDate: new Date(now + endInDays * day),
    })
    .returning();
  if (!sub) throw new Error('no subscription');
  return sub;
}

describe('searchUsers', () => {
  it('scopes rows and total by the search', async () => {
    const mark = marker();
    await seedUser(mark);
    await seedUser(mark);
    await seedUser(marker());

    const [rows, total] = await repo.searchUsers(params({ search: mark }));

    expect(total).toBe(2);
    expect(rows.every((r) => r.username?.startsWith(mark))).toBe(true);
  });

  it('never returns the password hash', async () => {
    const mark = marker();
    await seedUser(mark);

    const [rows] = await repo.searchUsers(params({ search: mark }));

    expect(rows[0]).not.toHaveProperty('passwordHash');
  });

  it('role filter returns only that role', async () => {
    const mark = marker();
    const admin = await seedUser(mark, { role: UserRole.ADMIN });
    await seedUser(mark, { role: UserRole.USER });

    const [rows, total] = await repo.searchUsers(params({ search: mark }), { role: 'admin' });

    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(admin.id);
  });

  it('user_type filter returns only that type', async () => {
    const mark = marker();
    const guest = await seedUser(mark, { userType: UserType.GUEST });
    await seedUser(mark, { userType: UserType.REGISTERED });

    const [rows, total] = await repo.searchUsers(params({ search: mark }), { userType: 'GUEST' });

    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(guest.id);
  });

  it('honours a whitelisted sort', async () => {
    const mark = marker();
    await seedUser(mark, { suffix: 'b' });
    await seedUser(mark, { suffix: 'a' });
    await seedUser(mark, { suffix: 'c' });

    const [rows] = await repo.searchUsers(params({ search: mark, sortBy: 'username', sortDir: 'asc' }));

    expect(rows.map((r) => r.username)).toEqual([`${mark}_a`, `${mark}_b`, `${mark}_c`]);
  });

  it('falls back to the default sort for an unknown column', async () => {
    const mark = marker();
    await seedUser(mark);
    await seedUser(mark);

    const [rows, total] = await repo.searchUsers(params({ search: mark, sortBy: 'password; DROP TABLE' }));

    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
  });
});

describe('per-user sub-lists', () => {
  it('scopes payments to the user', async () => {
    const mark = marker();
    const user = await seedUser(mark);
    const other = await seedUser(mark);
    for (const owner of [user, user, other]) {
      await t.db.insert(payments).values({
        userId: owner.id,
        productId: 'TEST_PRODUCT',
        providerId: PaymentProvider.YOOKASSA,
        amount: 100,
        currency: 'RUB',
        status: PaymentStatus.SUCCEEDED,
      });
    }

    const [rows, total] = await repo.listPayments(user.id, params());

    expect(total).toBe(2);
    expect(new Set(rows.map((p) => p.userId))).toEqual(new Set([user.id]));
    expect(await repo.countPayments(user.id)).toBe(2);
  });

  it('lists subscriptions newest first', async () => {
    const user = await seedUser(marker());
    await seedSubscription(user, SubscriptionStatus.EXPIRED, -1);
    await seedSubscription(user, SubscriptionStatus.ACTIVE, 10);

    const rows = await repo.listSubscriptions(user.id);

    expect(rows).toHaveLength(2);
    expect((rows[0]?.startDate.getTime() ?? 0) >= (rows[1]?.startDate.getTime() ?? 0)).toBe(true);
  });
});

describe('getActiveSubscription', () => {
  it.each([
    [SubscriptionStatus.ACTIVE, 10, true],
    [SubscriptionStatus.PAST_DUE, 10, true],
    // A canceled sub still runs to its end date.
    [SubscriptionStatus.CANCELED, 10, true],
    [SubscriptionStatus.EXPIRED, 10, false],
    [SubscriptionStatus.ACTIVE, -1, false],
  ])('status %s ending in %i days is entitled: %s', async (status, endInDays, isActive) => {
    const user = await seedUser(marker());
    const sub = await seedSubscription(user, status, endInDays);

    const active = await repo.getActiveSubscription(user.id);

    if (isActive) expect(active?.id).toBe(sub.id);
    else expect(active).toBeNull();
  });

  it('prefers the latest ending entitled subscription', async () => {
    const user = await seedUser(marker());
    await seedSubscription(user, SubscriptionStatus.CANCELED, 5);
    const later = await seedSubscription(user, SubscriptionStatus.ACTIVE, 40);

    expect((await repo.getActiveSubscription(user.id))?.id).toBe(later.id);
  });
});
