/** Helpers for the money-path tests: Python's `tests/payments/_factories.py` and fixtures. */
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/client';
import {
  type NewPayment,
  type NewSubscription,
  PaymentProvider,
  PaymentStatus,
  SubscriptionStatus,
} from '../../db/schema';
import { Repos } from '../../repos';
import { asUser, createUser, type TestApp, TestServices } from '../../testing';
import type { SubscriptionJobContext } from '../subscriptions/jobs';
import type { Json } from './types';
import { addDays } from './utils';

export const STARS = PaymentProvider.TELEGRAM_STARS;
export { asUser };

export const uniqueId = (prefix: string) => `${prefix}_${randomBytes(4).toString('hex')}`;

/** Rows through a repo on the pool: committed at once. */
export const reposOf = (t: TestApp) => new Repos(t.db as unknown as Db);

/** Services on one transaction, as a job or a bot update has them. */
export const inTransaction = <T>(t: TestApp, fn: (services: TestServices) => Promise<T>): Promise<T> =>
  t.db.transaction((tx) =>
    fn(new TestServices(new Repos(tx as never), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue)),
  );

/** What a job gets from the worker. */
export const jobContext = (t: TestApp): SubscriptionJobContext => ({
  withTransaction: (fn) => inTransaction(t, fn),
});

export function makeSubscription(t: TestApp, userId: string, overrides: Partial<NewSubscription> & { endDate: Date }) {
  const paymentMethodId = overrides.paymentMethodId === undefined ? 'pm_test' : overrides.paymentMethodId;
  return reposOf(t).subscriptions.create({
    userId,
    productId: 'MONTH_SUB',
    providerId: PaymentProvider.YOOKASSA,
    status: SubscriptionStatus.ACTIVE,
    currency: 'RUB',
    startDate: addDays(new Date(), -30),
    recurringDetails: paymentMethodId ? { payment_method_id: paymentMethodId } : {},
    ...overrides,
    paymentMethodId,
  });
}

export function makePayment(t: TestApp, userId: string, overrides: Partial<NewPayment> = {}) {
  return reposOf(t).payments.create({
    userId,
    productId: 'MONTH_SUB',
    providerId: PaymentProvider.YOOKASSA,
    amount: 100,
    currency: 'RUB',
    status: PaymentStatus.SUCCEEDED,
    isRecurring: true,
    providerMetadata: {},
    ...overrides,
  });
}

/** The WAITING_FOR_ACTION row `createPayment` leaves before the user pays the invoice. */
export const makeInitialStarsPayment = (t: TestApp, userId: string, productId = 'MONTH_SUB_V3') =>
  makePayment(t, userId, {
    productId,
    providerId: STARS,
    currency: 'XTR',
    status: PaymentStatus.WAITING_FOR_ACTION,
    isRecurring: false,
    providerPaymentId: 'tg_stars_init',
  });

export const createStarsUser = (t: TestApp, telegramId: number) => createUser(t.db, { telegramId });

/** The text of every `admin_broadcast_job` queued. */
export const adminMessages = (t: TestApp): string[] =>
  t.fakes.queue.jobs
    .filter((job) => job.jobName === 'admin_broadcast_job')
    .map((job) => (job.payload as { text: string }).text);

export const events = (t: TestApp, name: string) => t.fakes.posthog.events.filter((event) => event.event === name);

export function resetFakes(t: TestApp): void {
  t.fakes.queue.jobs.length = 0;
  t.fakes.posthog.events.length = 0;
  t.fakes.bot.clear();
}

/** Between tests of what selects across users or keys rows by charge id, as Python's `clean_tables`. */
export async function cleanMoneyTables(t: TestApp): Promise<void> {
  await t.db.execute('TRUNCATE payment_events, payments, subscriptions, failed_webhooks CASCADE');
}

export const notification = (event: string, object: Json) => ({ type: 'notification', event, object });
