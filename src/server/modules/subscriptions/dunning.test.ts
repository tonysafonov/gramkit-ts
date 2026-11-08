/** The dunning state machine in the renewal job and the expiry grace safety net: Python gramkit's `test_dunning.py`. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentStatus, payments, SubscriptionStatus } from '../../db/schema';
import { createTestApp, createUser, FakeYooKassa, type TestApp } from '../../testing';
import { products } from '../payments/products';
import { renewalIdempotencyKey } from '../payments/providers/yookassa';
import {
  adminMessages,
  cleanMoneyTables,
  events,
  jobContext,
  makePayment,
  makeSubscription,
  reposOf,
  resetFakes,
} from '../payments/test-helpers';
import { addDays } from '../payments/utils';
import { chargeExpiringSubscriptionsJob, expireOutdatedSubscriptionsJob, jobs } from './jobs';

let t: TestApp;
let yookassa: FakeYooKassa;

const HOUR = 3_600_000;

/** Twelve hours ahead, on a whole second. */
const soon = () => new Date(Math.floor((Date.now() + 12 * HOUR) / 1000) * 1000);

const seed = async (overrides: Parameters<typeof makeSubscription>[2]) => {
  const user = await createUser(t.db);
  const subscription = await makeSubscription(t, user.id, overrides);
  return { userId: user.id, subId: subscription.id };
};

const getSub = async (id: string) => {
  const subscription = await reposOf(t).subscriptions.getById(id);
  if (!subscription) throw new Error('no subscription');
  return subscription;
};

const charge = () => chargeExpiringSubscriptionsJob(jobContext(t), products);
const expire = () => expireOutdatedSubscriptionsJob(jobContext(t), products);

const paymentEvents = () => [...events(t, 'payment_succeeded'), ...events(t, 'payment_failed')];

const backdate = (paymentId: string, createdAt: Date) =>
  t.db.update(payments).set({ createdAt }).where(eq(payments.id, paymentId));

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

beforeEach(() => {
  yookassa = new FakeYooKassa().install();
});

afterEach(async () => {
  yookassa.uninstall();
  resetFakes(t);
  await cleanMoneyTables(t); // the job selects every chargeable row: a test's leftovers must not reach the next one
});

describe('renewal outcomes', () => {
  it('a successful renewal stays ACTIVE, extends the period and reaches PostHog as recurring', async () => {
    yookassa.status = 'succeeded';
    const end = soon();
    const { subId } = await seed({ endDate: end });

    const results = await charge();

    expect(results).toMatchObject({ success: 1, failed: 0 });
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription.failedRenewalCount).toBe(0);
    expect(subscription.endDate.getTime()).toBeGreaterThan(end.getTime());

    const [event] = paymentEvents();
    expect(paymentEvents()).toHaveLength(1);
    expect(event?.event).toBe('payment_succeeded');
    expect(event?.distinctId).toBe(subscription.userId);
    expect(event?.properties).toMatchObject({ is_recurring: true, product_id: subscription.productId });
    expect(event?.properties.amount).toBeGreaterThan(0);
  });

  it('charges the saved card as the SDK does', async () => {
    yookassa.status = 'succeeded';
    const { userId } = await seed({ endDate: soon() });

    await charge();

    const [payment] = await reposOf(t).payments.getByUserId(userId);
    const body = yookassa.requests.at(-1)?.body;
    expect(body).toMatchObject({
      payment_method_id: 'pm_test',
      description: `Auto-renewal: Monthly Subscription for user_id: ${userId}`,
      metadata: { app_payment_id: payment?.id, is_recurring: true },
    });
    expect(body).not.toHaveProperty('confirmation');
    expect(body).not.toHaveProperty('save_payment_method');
    expect(payment).toMatchObject({ status: 'SUCCEEDED', isRecurring: true, wasRewarded: true });
    expect(payment?.providerPaymentId).toMatch(/^payment_test_/);
  });

  it('falls back to the card in recurring_details for rows from before the column', async () => {
    yookassa.status = 'succeeded';
    await seed({ endDate: soon(), paymentMethodId: null, recurringDetails: { payment_method_id: 'pm_old' } });

    await charge();

    expect(yookassa.requests.at(-1)?.body).toMatchObject({ payment_method_id: 'pm_old' });
  });

  it('a decline moves to PAST_DUE and reports the reason', async () => {
    yookassa.status = 'canceled';
    yookassa.cancellationReason = 'insufficient_funds';
    const { subId } = await seed({ endDate: soon() });

    const results = await charge();

    expect(results).toMatchObject({ failed: 1, past_due: 1 });
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.PAST_DUE);
    expect(subscription.failedRenewalCount).toBe(1);

    const [event] = paymentEvents();
    expect(event?.event).toBe('payment_failed');
    expect(event?.properties).toMatchObject({ is_recurring: true, reason: 'insufficient_funds', attempt: 1 });
    expect(adminMessages(t).some((m) => m.includes('Past due') && m.includes('attempt 1/3'))).toBe(true);
  });

  it('permission_revoked expires immediately', async () => {
    yookassa.status = 'canceled';
    yookassa.cancellationReason = 'permission_revoked';
    const { subId } = await seed({ endDate: soon() });

    const results = await charge();

    expect(results.dunning_expired).toBe(1);
    expect((await getSub(subId)).status).toBe(SubscriptionStatus.EXPIRED);
    expect(adminMessages(t).some((m) => m.includes('card revoked'))).toBe(true);
  });

  it('the third consecutive decline exhausts the budget', async () => {
    yookassa.status = 'canceled';
    const { subId } = await seed({ endDate: soon(), failedRenewalCount: 2 });

    await charge();

    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.EXPIRED);
    expect(subscription.failedRenewalCount).toBe(3);
    expect(adminMessages(t).some((m) => m.includes('retries exhausted after 3 attempts'))).toBe(true);
  });

  it('a recovery resets dunning', async () => {
    yookassa.status = 'succeeded';
    const { subId } = await seed({
      status: SubscriptionStatus.PAST_DUE,
      endDate: soon(),
      failedRenewalCount: 1,
      lastRenewalAttemptAt: new Date(Date.now() - 21 * HOUR), // older than the retry spacing
    });

    const results = await charge();

    expect(results).toMatchObject({ success: 1, recovered: 1 });
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription.failedRenewalCount).toBe(0);
    expect(adminMessages(t).some((m) => m.includes('Recovered'))).toBe(true);
  });

  it('a PAST_DUE sub attempted within the spacing is left for the next run', async () => {
    yookassa.status = 'succeeded'; // would succeed if it were attempted
    const { subId } = await seed({
      status: SubscriptionStatus.PAST_DUE,
      endDate: soon(),
      failedRenewalCount: 1,
      lastRenewalAttemptAt: new Date(),
    });

    const results = await charge();

    expect(results.skipped).toBe(1);
    expect(yookassa.createCount).toBe(0);
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.PAST_DUE);
    expect(subscription.failedRenewalCount).toBe(1);
  });

  it('a period that already has a SUCCEEDED renewal is skipped: no second charge', async () => {
    yookassa.status = 'succeeded';
    const end = soon();
    const { userId, subId } = await seed({ endDate: end });
    await makePayment(t, userId, { idempotencyKey: renewalIdempotencyKey(subId, end) });

    const results = await charge();

    expect(results.skipped).toBe(1);
    expect(yookassa.createCount).toBe(0);
    expect((await getSub(subId)).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('a product missing from the catalog is skipped', async () => {
    const { subId } = await seed({ endDate: soon(), productId: 'GONE_PRODUCT' });

    const results = await charge();

    expect(results.skipped).toBe(1);
    expect(yookassa.createCount).toBe(0);
    expect((await getSub(subId)).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('gifts are not charged', async () => {
    await seed({ endDate: soon(), productId: 'GIFT_SUB', providerId: 'GIFT' });

    const results = await charge();

    expect(results).toMatchObject({ success: 0, failed: 0, skipped: 0 });
    expect(yookassa.createCount).toBe(0);
  });

  it('Stars subs are monitored, never charged: native ones renew, one-time ones end', async () => {
    const native = await seed({
      endDate: soon(),
      productId: 'MONTH_SUB_V3',
      providerId: 'TELEGRAM_STARS',
      currency: 'XTR',
      recurringDetails: { telegram_subscription_charge_id: 'c1' },
    });
    await seed({
      endDate: soon(),
      productId: 'YEAR_SUB_V3',
      providerId: 'TELEGRAM_STARS',
      currency: 'XTR',
      recurringDetails: { telegram_subscription_managed: false },
    });

    const results = await charge();

    expect(results.skipped).toBe(2);
    expect(yookassa.createCount).toBe(0);
    expect((await getSub(native.subId)).status).toBe(SubscriptionStatus.ACTIVE);
    const [summary] = adminMessages(t);
    expect(summary).toContain('2 Stars subscriptions expiring');
    expect(summary).toContain('Telegram renews these itself:');
    expect(summary).toContain('One-time, these end:');
    expect(t.fakes.queue.jobs[0]?.payload).toMatchObject({ silent: true });
  });
});

describe('stranded-renewal recovery', () => {
  it('a stale non-terminal renewal is marked FAILED, then a fresh one is charged', async () => {
    yookassa.status = 'succeeded';
    const end = soon();
    const { userId, subId } = await seed({ endDate: end });
    const key = renewalIdempotencyKey(subId, end);
    const stranded = await makePayment(t, userId, { status: PaymentStatus.CREATED, idempotencyKey: key });
    await backdate(stranded.id, new Date(Date.now() - 45 * 60_000));

    await charge();

    const recovered = await reposOf(t).payments.getById(stranded.id);
    expect(recovered?.status).toBe(PaymentStatus.FAILED);
    expect(recovered?.providerMetadata.recovered).toBe('stranded_mid_flow');

    const fresh = await reposOf(t).payments.getSucceededRenewalForPeriod(key);
    expect(fresh).not.toBeNull();
    expect(fresh?.id).not.toBe(stranded.id);
    expect(yookassa.createCount).toBe(1);

    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription.endDate.getTime()).toBeGreaterThan(end.getTime());
  });

  it('a non-terminal renewal within the window is treated as in flight: skipped', async () => {
    yookassa.status = 'succeeded';
    const end = soon();
    const { userId, subId } = await seed({ endDate: end });
    await makePayment(t, userId, { status: PaymentStatus.CREATED, idempotencyKey: renewalIdempotencyKey(subId, end) });

    await charge();

    expect(yookassa.createCount).toBe(0);
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription.endDate).toEqual(end);
    expect(subscription.failedRenewalCount).toBe(0);
  });
});

describe('a database taken over from Python', () => {
  it('a renewal Python left in flight for an end_date with microseconds is found: no second charge', async () => {
    yookassa.status = 'succeeded';
    const { userId, subId } = await seed({ endDate: soon() });
    // Python sets end_date from datetime.now(UTC): it has microseconds, which a JS Date can't hold
    await t.db.execute(
      sql`UPDATE subscriptions SET end_date = date_trunc('second', end_date) + interval '0.123456 second' WHERE id = ${subId}`,
    );
    const end = (await getSub(subId)).endDate;
    const pythonEnd = `${end.toISOString().slice(0, 19)}.123456+00:00`; // Python's end_date.isoformat()
    const pythonKey = createHash('sha256').update(`renewal:${subId}:${pythonEnd}`).digest('hex').slice(0, 32);
    await makePayment(t, userId, { status: PaymentStatus.CREATED, idempotencyKey: pythonKey });

    await charge();

    expect(yookassa.createCount).toBe(0);
    expect(await reposOf(t).payments.getByUserId(userId)).toHaveLength(1);
  });

  it('a renewal Python already charged for that end_date is found: skipped', async () => {
    yookassa.status = 'succeeded';
    const { userId, subId } = await seed({ endDate: soon() });
    await t.db.execute(
      sql`UPDATE subscriptions SET end_date = date_trunc('second', end_date) + interval '0.000789 second' WHERE id = ${subId}`,
    );
    const end = (await getSub(subId)).endDate;
    const pythonEnd = `${end.toISOString().slice(0, 19)}.000789+00:00`;
    const pythonKey = createHash('sha256').update(`renewal:${subId}:${pythonEnd}`).digest('hex').slice(0, 32);
    await makePayment(t, userId, { status: PaymentStatus.SUCCEEDED, idempotencyKey: pythonKey });

    const results = await charge();

    expect(results.skipped).toBe(1);
    expect(yookassa.createCount).toBe(0);
  });
});

describe('a concurrent run', () => {
  it('the second of two simultaneous runs is stopped by the unique index, and the card is charged once', async () => {
    yookassa.status = 'succeeded';
    const { subId } = await seed({ endDate: soon() });

    const results = await Promise.all([charge(), charge()]);

    expect(yookassa.createCount).toBe(1);
    expect(results.map((r) => r.success).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.skipped).sort()).toEqual([0, 1]);
    expect((await getSub(subId)).status).toBe(SubscriptionStatus.ACTIVE);
  });
});

describe('bare transport exception', () => {
  it('does not advance dunning: it stamps the attempt and marks the payment FAILED', async () => {
    yookassa.networkError = new Error('network timeout');
    const end = soon();
    const { subId } = await seed({ endDate: end });

    const results = await charge();

    expect(results.failed).toBe(1);
    expect(yookassa.createCount).toBe(1); // reached, and blew up
    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription.failedRenewalCount).toBe(0);
    expect(subscription.lastRenewalAttemptAt).not.toBeNull();
    expect(subscription.endDate).toEqual(end);

    const key = renewalIdempotencyKey(subId, end);
    expect(await reposOf(t).payments.getNonterminalRenewalForPeriod(key)).toBeNull();
    const all = await reposOf(t).payments.getByUserId(subscription.userId);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe(PaymentStatus.FAILED);
    expect(all[0]?.providerMetadata.error).toBe('network timeout');
    // Outcome unknown (the card may have been charged): report neither success nor failure.
    expect(paymentEvents()).toEqual([]);
  });

  it('the next run retries with the same key', async () => {
    yookassa.networkError = new Error('network timeout');
    const { subId } = await seed({ endDate: soon() });
    await charge();
    const key = yookassa.lastIdempotenceKey;

    yookassa.networkError = null;
    yookassa.status = 'succeeded';
    await charge();

    expect(yookassa.lastIdempotenceKey).toBe(key);
    expect(yookassa.createCount).toBe(2);
    expect((await getSub(subId)).failedRenewalCount).toBe(0);
  });
});

describe('the idempotency key', () => {
  it('the key the job computes is the Idempotence-Key YooKassa gets', async () => {
    yookassa.status = 'succeeded';
    const end = soon();
    const { subId } = await seed({ endDate: end });

    await charge();

    expect(yookassa.lastIdempotenceKey).toBe(renewalIdempotencyKey(subId, end));
    expect((await getSub(subId)).endDate.getTime()).toBeGreaterThan(end.getTime());
  });
});

describe('expiry grace safety net', () => {
  it('a PAST_DUE sub beyond the grace is expired', async () => {
    const { subId } = await seed({ status: SubscriptionStatus.PAST_DUE, endDate: addDays(new Date(), -5) });

    await expire();

    expect((await getSub(subId)).status).toBe(SubscriptionStatus.EXPIRED);
    expect(adminMessages(t).some((m) => m.includes('past-due grace elapsed'))).toBe(true);
  });

  it('a PAST_DUE sub within the grace is kept', async () => {
    const { subId } = await seed({ status: SubscriptionStatus.PAST_DUE, endDate: addDays(new Date(), -1) });

    expect(await expire()).toEqual({ expired: 0 });

    expect((await getSub(subId)).status).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('an ACTIVE sub past its end date is expired, with the summary', async () => {
    const { subId } = await seed({ endDate: new Date(Date.now() - HOUR) });

    expect(await expire()).toEqual({ expired: 1, total: 1 });

    const subscription = await getSub(subId);
    expect(subscription.status).toBe(SubscriptionStatus.EXPIRED);
    expect(subscription.canceledAt).not.toBeNull();
    const [summary] = adminMessages(t);
    expect(summary).toContain('1 subscriptions expired');
    expect(summary).toContain('Monthly Subscription, 29d');
    expect(summary).not.toContain('grace');
    expect(t.fakes.queue.jobs[0]?.payload).toMatchObject({ silent: true });
  });

  it('a CANCELED sub is not touched', async () => {
    const { subId } = await seed({ status: SubscriptionStatus.CANCELED, endDate: new Date(Date.now() - HOUR) });

    await expire();

    expect((await getSub(subId)).status).toBe(SubscriptionStatus.CANCELED);
  });
});

describe('the jobs map', () => {
  it('holds both jobs under their Python names', async () => {
    expect(Object.keys(jobs)).toEqual(['charge_expiring_subscriptions_job', 'expire_outdated_subscriptions_job']);
    expect(await jobs.expire_outdated_subscriptions_job(jobContext(t))).toEqual({ expired: 0 });
  });
});
