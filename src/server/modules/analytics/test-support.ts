/** Shared by the growth modules' tests: payments, subscriptions and a service aggregator on the test pool. */
import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client';
import {
  type NewPayment,
  type NewSubscription,
  PaymentProvider,
  PaymentStatus,
  payments,
  SubscriptionStatus,
  subscriptions,
} from '../../db/schema';
import { Repos } from '../../repos';
import type { TestApp } from '../../testing';
import { createUser, TestServices } from '../../testing';

export const uniq = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;

/** A `Services` on the file's pool (no request, no transaction): each statement commits. */
export function servicesFor<S extends TestServices = TestServices>(
  t: Pick<TestApp<unknown>, 'db' | 'fakes'>,
  servicesClass: new (...args: ConstructorParameters<typeof TestServices>) => S = TestServices as never,
): S {
  return new servicesClass(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);
}

export async function pay(
  db: Database,
  userId: string,
  overrides: Partial<NewPayment> & { amount: number; currency?: string },
) {
  const [row] = await db
    .insert(payments)
    .values({
      userId,
      productId: 'TEST_PRODUCT',
      providerId: PaymentProvider.YOOKASSA,
      currency: 'RUB',
      status: PaymentStatus.SUCCEEDED,
      isRecurring: false,
      providerMetadata: {},
      ...overrides,
    })
    .returning();
  return row;
}

export async function subscribe(
  db: Database,
  overrides: Partial<NewSubscription> & { productId: string },
): Promise<void> {
  const user = await createUser(db);
  const now = Date.now();
  await db.insert(subscriptions).values({
    userId: user.id,
    providerId: PaymentProvider.YOOKASSA,
    status: SubscriptionStatus.ACTIVE,
    currency: 'RUB',
    startDate: new Date(now - 2 * 86_400_000),
    endDate: new Date(now + 20 * 86_400_000),
    recurringDetails: {},
    ...overrides,
  });
}
