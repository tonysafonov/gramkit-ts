/** Subscription routes, the one-live-sub index, PAST_DUE entitlement and the admin alerts. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PaymentProvider, SubscriptionStatus, UserType } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import {
  adminMessages,
  inTransaction,
  makePayment,
  makeSubscription,
  reposOf,
  resetFakes,
} from '../payments/test-helpers';
import { addDays } from '../payments/utils';
import { getMockSubscription, toSubscriptionResponse } from './schemas';

let t: TestApp;

const hasActive = (userId: string) =>
  inTransaction(t, (services) => services.subscriptions.hasActiveSubscription(userId));

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

afterEach(() => resetFakes(t));

describe('GET /subscriptions/', () => {
  it('answers the mock for a user with none, with pricing', async () => {
    const user = await createUser(t.db);

    const res = await t.client.get('/subscriptions/', { headers: asUser(user) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      user_id: user.id,
      product_id: 'MOCK',
      status: 'NONE',
      provider_id: 'GIFT',
      product_price: 1.99,
      currency: 'USD',
      canceled_at: null,
      has_access: false,
    });
    expect(Object.keys(body)).toEqual([
      'id',
      'user_id',
      'product_id',
      'status',
      'start_date',
      'end_date',
      'canceled_at',
      'cancellation_reason',
      'cancellation_feedback',
      'has_access',
      'provider_id',
      'product_price',
      'currency',
    ]);
  });

  it('prices an active subscription in its own currency', async () => {
    const user = await createUser(t.db);
    const subscription = await makeSubscription(t, user.id, {
      endDate: addDays(new Date(), 10),
      productId: 'MONTH_SUB_V3',
      currency: 'USD',
    });

    const res = await t.client.get('/subscriptions/', { headers: asUser(user) });

    expect(await res.json()).toMatchObject({
      id: subscription.id,
      status: 'ACTIVE',
      product_id: 'MONTH_SUB_V3',
      provider_id: 'YOOKASSA',
      product_price: 3.99,
      currency: 'USD',
      has_access: true,
    });
  });

  it('a gift costs nothing; a product gone from the catalog too', async () => {
    const gifted = await createUser(t.db);
    await makeSubscription(t, gifted.id, {
      endDate: addDays(new Date(), 10),
      productId: 'GIFT_SUB',
      providerId: PaymentProvider.GIFT,
    });
    const orphan = await createUser(t.db);
    await makeSubscription(t, orphan.id, { endDate: addDays(new Date(), 10), productId: 'GONE' });

    expect(await (await t.client.get('/subscriptions/', { headers: asUser(gifted) })).json()).toMatchObject({
      product_price: 0,
    });
    expect(await (await t.client.get('/subscriptions/', { headers: asUser(orphan) })).json()).toMatchObject({
      product_price: 0,
    });
  });

  it('the details leave the cancellation fields empty, as Python does', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, {
      endDate: addDays(new Date(), 10),
      status: SubscriptionStatus.CANCELED,
      canceledAt: new Date(),
      cancellationReason: 'notUsing',
    });

    const res = await t.client.get('/subscriptions/', { headers: asUser(user) });

    expect(await res.json()).toMatchObject({ status: 'CANCELED', canceled_at: null, cancellation_reason: null });
  });
});

describe('POST /subscriptions/cancel', () => {
  it('works with no subscription: the mock', async () => {
    const user = await createUser(t.db);

    const res = await t.client.post('/subscriptions/cancel', { reason: 'notUsing' }, { headers: asUser(user) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'NONE', product_id: 'MOCK', user_id: user.id });
  });

  it('accepts feedback and answers the canceled subscription', async () => {
    const user = await createUser(t.db);
    const subscription = await makeSubscription(t, user.id, { endDate: addDays(new Date(), 10) });

    const res = await t.client.post(
      '/subscriptions/cancel',
      { reason: 'tooExpensive', feedback: 'Price too high.' },
      { headers: asUser(user) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: subscription.id,
      status: 'CANCELED',
      cancellation_reason: 'tooExpensive',
      cancellation_feedback: 'Price too high.',
      has_access: true,
    });
    expect(body.canceled_at).toBeTruthy();
    expect(Object.keys(body)).toEqual([
      'id',
      'user_id',
      'product_id',
      'status',
      'start_date',
      'end_date',
      'canceled_at',
      'cancellation_reason',
      'cancellation_feedback',
      'has_access',
    ]);
  });

  it('an empty object is enough, and no body at all is a 422', async () => {
    const user = await createUser(t.db);

    expect((await t.client.post('/subscriptions/cancel', {}, { headers: asUser(user) })).status).toBe(200);
    const res = await t.client.post('/subscriptions/cancel', undefined, { headers: asUser(user) });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: [{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }],
    });
  });

  it('a reason over 50 characters is a 422', async () => {
    const user = await createUser(t.db);

    const res = await t.client.post('/subscriptions/cancel', { reason: 'x'.repeat(51) }, { headers: asUser(user) });

    expect(res.status).toBe(422);
  });

  it("a logged-out visitor gets a 401: the shared guest's subscription is everyone's", async () => {
    await inTransaction(t, (services) =>
      services.users.getOrCreateUser({ id: MOCK_GUEST_USER_ID, userType: UserType.GUEST, displayName: 'Guest' }),
    );
    const subscription = await makeSubscription(t, MOCK_GUEST_USER_ID, { endDate: addDays(new Date(), 10) });

    const res = await t.client.post('/subscriptions/cancel', { reason: 'notUsing' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: { error: 'not_authenticated', message: 'Login required' } });
    expect((await reposOf(t).subscriptions.getById(subscription.id))?.status).toBe(SubscriptionStatus.ACTIVE);
    await reposOf(t).subscriptions.update(subscription.id, { status: SubscriptionStatus.EXPIRED });
  });
});

describe('one live subscription per user', () => {
  const now = new Date();

  it('a second live subscription is rejected', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { endDate: addDays(now, 10) });

    await expect(makeSubscription(t, user.id, { endDate: addDays(now, 20) })).rejects.toThrow();
  });

  it('PAST_DUE also counts as live', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { endDate: addDays(now, 10) });

    await expect(
      makeSubscription(t, user.id, { status: SubscriptionStatus.PAST_DUE, endDate: addDays(now, 5) }),
    ).rejects.toThrow();
  });

  it('an EXPIRED history row is allowed', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { status: SubscriptionStatus.EXPIRED, endDate: addDays(now, -5) });

    const live = await makeSubscription(t, user.id, { endDate: addDays(now, 10) });

    expect(live.id).toBeTruthy();
  });
});

describe('entitlement', () => {
  it('a PAST_DUE sub in its grace window is the active subscription', async () => {
    const user = await createUser(t.db);
    const subscription = await makeSubscription(t, user.id, {
      status: SubscriptionStatus.PAST_DUE,
      endDate: addDays(new Date(), 2),
    });

    expect((await reposOf(t).subscriptions.getActiveByUserId(user.id))?.id).toBe(subscription.id);
    expect(await hasActive(user.id)).toBe(true);
  });

  it('an EXPIRED one is not', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { status: SubscriptionStatus.EXPIRED, endDate: addDays(new Date(), -1) });

    expect(await reposOf(t).subscriptions.getActiveByUserId(user.id)).toBeNull();
    expect(await hasActive(user.id)).toBe(false);
  });

  it('a CANCELED one gives access until its end date', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { status: SubscriptionStatus.CANCELED, endDate: addDays(new Date(), 3) });

    expect(await hasActive(user.id)).toBe(true);
  });
});

describe('counts', () => {
  it('count entitled users, statuses and the ended in a window', async () => {
    const before = await reposOf(t).subscriptions.getActiveSubscribersCount();
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { status: SubscriptionStatus.EXPIRED, endDate: addDays(new Date(), -5) });
    await makeSubscription(t, user.id, {
      status: SubscriptionStatus.CANCELED,
      endDate: addDays(new Date(), 5),
      canceledAt: new Date(),
    });
    const repo = reposOf(t).subscriptions;

    expect(await repo.getActiveSubscribersCount()).toBe(before + 1);
    expect(await repo.countByStatus(SubscriptionStatus.EXPIRED)).toBeGreaterThan(0);
    expect(await repo.countEndedBetween(SubscriptionStatus.CANCELED, addDays(new Date(), -1))).toBeGreaterThan(0);
    expect(await repo.countEndedBetween(SubscriptionStatus.CANCELED, addDays(new Date(), 1))).toBe(0);
  });
});

describe('topUpSubscription', () => {
  it('creates a subscription and flips isOnboarded', async () => {
    const user = await createUser(t.db, { isOnboarded: false });
    const payment = await makePayment(t, user.id, { productId: 'WEEK_SUB' });

    const subscription = await inTransaction(t, (services) =>
      services.subscriptions.topUpSubscription(user.id, 'WEEK_SUB', 7, payment, { payment_method_id: 'pm_1' }),
    );

    expect(subscription).toMatchObject({ status: 'ACTIVE', productId: 'WEEK_SUB', paymentMethodId: 'pm_1' });
    expect((await reposOf(t).payments.getById(payment.id))?.subscriptionId).toBe(subscription.id);
    expect((await reposOf(t).users.getById(user.id))?.isOnboarded).toBe(true);
  });

  it('extends from the end date, keeps the card and merges the details', async () => {
    const user = await createUser(t.db);
    const end = addDays(new Date(), 10);
    const existing = await makeSubscription(t, user.id, { endDate: end });
    const payment = await makePayment(t, user.id, { productId: 'WEEK_SUB' });

    const subscription = await inTransaction(t, (services) =>
      services.subscriptions.topUpSubscription(user.id, 'WEEK_SUB', 7, payment, { extra: 1 }),
    );

    expect(subscription.id).toBe(existing.id);
    expect(subscription.endDate).toEqual(addDays(end, 7));
    expect(subscription.productId).toBe('WEEK_SUB');
    expect(subscription.paymentMethodId).toBe('pm_test');
    expect(subscription.recurringDetails).toEqual({ payment_method_id: 'pm_test', extra: 1 });
  });

  it('reuses an ended-but-still-ACTIVE row after downtime, extending from now', async () => {
    const user = await createUser(t.db);
    const existing = await makeSubscription(t, user.id, { endDate: addDays(new Date(), -2) });
    const payment = await makePayment(t, user.id);

    const subscription = await inTransaction(t, (services) =>
      services.subscriptions.topUpSubscription(user.id, 'MONTH_SUB', 30, payment, {}),
    );

    expect(subscription.id).toBe(existing.id);
    expect(subscription.endDate.getTime()).toBeGreaterThan(addDays(new Date(), 29).getTime());
    expect(await reposOf(t).subscriptions.getByUserId(user.id)).toHaveLength(1);
  });

  it('a manual payment renews the PAST_DUE dunning row', async () => {
    const user = await createUser(t.db);
    const existing = await makeSubscription(t, user.id, {
      status: SubscriptionStatus.PAST_DUE,
      endDate: addDays(new Date(), -1),
    });
    const payment = await makePayment(t, user.id);

    const subscription = await inTransaction(t, (services) =>
      services.subscriptions.topUpSubscription(user.id, 'MONTH_SUB', 30, payment, {}),
    );

    expect(subscription).toMatchObject({ id: existing.id, status: 'ACTIVE' });
  });
});

describe('giftSubscription', () => {
  it('creates a GIFT sub and records who gifted it', async () => {
    const user = await createUser(t.db, { isOnboarded: false });
    const admin = randomUUID();

    const gift = await inTransaction(t, (services) => services.subscriptions.giftSubscription(user.id, 30, admin));

    expect(gift).toMatchObject({ productId: 'GIFT_SUB', status: 'ACTIVE', hasAccess: true });
    const row = await reposOf(t).subscriptions.getById(gift.id);
    expect(row).toMatchObject({ providerId: 'GIFT', currency: 'RUB', recurringDetails: { gifted_by: admin } });
    expect((await reposOf(t).users.getById(user.id))?.isOnboarded).toBe(true);
  });

  it('extends an entitled sub and forces it ACTIVE', async () => {
    const user = await createUser(t.db);
    const end = addDays(new Date(), 5);
    const existing = await makeSubscription(t, user.id, { status: SubscriptionStatus.CANCELED, endDate: end });

    const gift = await inTransaction(t, (services) => services.subscriptions.giftSubscription(user.id, 7));

    expect(gift).toMatchObject({ id: existing.id, status: 'ACTIVE', endDate: addDays(end, 7) });
  });
});

describe('admin alerts', () => {
  it('a purchase shows the amount, the product and the customer', async () => {
    const user = await createUser(t.db, { telegramId: 555001, tgUsername: 'anna' });
    const payment = await makePayment(t, user.id, { isRecurring: false, productId: 'WEEK_SUB' });

    await inTransaction(t, (services) => services.subscriptions.topUpSubscription(user.id, 'WEEK_SUB', 7, payment, {}));

    const [text] = adminMessages(t).filter((m) => m.includes('Purchase'));
    expect(text).toContain('<b>Purchase · 100');
    expect(text).toContain('Weekly Subscription');
    expect(text).toContain('<a href="tg://user?id=555001">@anna</a>');
    expect(text).toContain('1 payment · LTV 100');
    expect(text?.endsWith('#purchase #u_anna')).toBe(true);
    expect(t.fakes.queue.jobs.at(-1)?.payload).toMatchObject({ silent: false }); // money is worth a buzz
  });

  it('a renewal says until when', async () => {
    const user = await createUser(t.db);
    await makeSubscription(t, user.id, { endDate: addDays(new Date(), 3) });
    const payment = await makePayment(t, user.id, { productId: 'WEEK_SUB' });

    await inTransaction(t, (services) => services.subscriptions.topUpSubscription(user.id, 'WEEK_SUB', 7, payment, {}));

    const [text] = adminMessages(t).filter((m) => m.includes('Renewal'));
    expect(text).toContain(' · until ');
    expect(text).toContain('#renewal');
  });

  it('a cancel escapes the user feedback', async () => {
    const user = await createUser(t.db, { username: null, tgUsername: null, telegramId: null });
    await makeSubscription(t, user.id, { endDate: addDays(new Date(), 10) });

    await inTransaction(t, (services) =>
      services.subscriptions.cancelSubscription(user.id, 'tooExpensive', 'дорого <3 & всё'),
    );

    const [text] = adminMessages(t).filter((m) => m.includes('Canceled'));
    expect(text).toContain('<blockquote>дорого &lt;3 &amp; всё</blockquote>');
    expect(text).toContain('Reason: <b>Too expensive</b>');
    expect(text).toContain('subscribed 30 days');
    expect(text).not.toContain('@null');
    expect(text).toContain('\n#cancel #u_');
  });
});

describe('mock subscription', () => {
  it('ended a day ago, with no access', () => {
    const mock = getMockSubscription('u1');

    expect(mock).toMatchObject({ productId: 'MOCK', status: 'NONE', hasAccess: false, userId: 'u1' });
    expect(mock.canceledAt).toEqual(mock.endDate);
    expect(toSubscriptionResponse(mock).canceled_at).toBe(mock.endDate.toISOString());
  });
});
