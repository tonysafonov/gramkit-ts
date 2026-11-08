/**
 * The webhook routes end to end: security (the re-fetch decides, not the body), refund.* notifications, is_recurring,
 * analytics, status codes and the dead letter queue. Port of Python gramkit's `test_webhook_security.py`,
 * `test_refund_webhook.py`, `test_payment_is_recurring.py`, `test_payment_analytics.py`, and the routers' branches.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { failedWebhooks, PaymentEventType, PaymentProvider, PaymentStatus, SubscriptionStatus } from '../../db/schema';
import { asUser, createTestApp, createUser, FakeYooKassa, type TestApp, type TestServices } from '../../testing';
import { paymentMethodType } from '../payments/service';
import {
  adminMessages,
  events,
  inTransaction,
  makeInitialStarsPayment,
  makePayment,
  makeSubscription,
  notification,
  reposOf,
  resetFakes,
} from '../payments/test-helpers';
import { PaymentValueError } from '../payments/types';
import { addDays } from '../payments/utils';

let t: TestApp;
let yookassa: FakeYooKassa;

const YOOKASSA = '/yookassa/webhook';
const STARS = '/telegram-stars/webhook';

/** The Stars webhook is off without a secret: the tests run with one, sent unless a test sends its own header. */
const STARS_SECRET = 'stars-secret';
const STARS_HEADERS = { 'x-telegram-bot-api-secret-token': STARS_SECRET };
const webhookState = () => t.api.state as unknown as { yookassaWebhookSecret?: string; telegramWebhookSecret?: string };

const post = (path: string, body: unknown, headers?: Record<string, string>) =>
  t.client.post(path, body, { headers: path === STARS ? { ...STARS_HEADERS, ...headers } : headers });

/** A body claiming `status`, with YooKassa knowing the payment. The body itself is never trusted. */
function webhook(paymentId: string, status: string, fields: Record<string, unknown> = {}) {
  const object = { id: `yk_${paymentId.slice(0, 8)}`, status, metadata: { app_payment_id: paymentId }, ...fields };
  yookassa.addPayment(object);
  return notification(`payment.${status}`, object);
}

const dlq = () => t.db.select().from(failedWebhooks);
const lastDlq = async () => (await dlq()).at(-1);

const waiting = async (overrides: Parameters<typeof makePayment>[2] = {}) => {
  const user = await createUser(t.db);
  const payment = await makePayment(t, user.id, {
    status: PaymentStatus.WAITING_FOR_ACTION,
    productId: 'MONTH_SUB_V3',
    ...overrides,
  });
  return { user, payment };
};

beforeAll(async () => {
  t = await createTestApp();
  webhookState().telegramWebhookSecret = STARS_SECRET;
});

afterAll(() => t.close());

beforeEach(() => {
  yookassa = new FakeYooKassa().install();
});

afterEach(() => {
  yookassa.uninstall();
  resetFakes(t);
});

describe('re-fetch security', () => {
  const forged = (paymentId: string) => {
    const object = {
      id: 'provider_payment_forged',
      status: 'succeeded',
      metadata: { app_payment_id: paymentId, is_recurring: 'true' },
      payment_method: { id: 'pm_forged', type: 'bank_card' },
    };
    yookassa.addPayment(object);
    return notification('payment.succeeded', object);
  };

  it('a forged succeeded body does not grant when the real status is pending', async () => {
    const { user, payment } = await waiting();
    const body = forged(payment.id);
    yookassa.remoteStatus = 'pending';

    const res = await post(YOOKASSA, body);

    expect(res.status).toBe(200);
    expect((await reposOf(t).payments.getById(payment.id))?.status).not.toBe('SUCCEEDED');
    expect(await reposOf(t).subscriptions.getActiveByUserId(user.id)).toBeNull();
  });

  it('a genuine succeeded is processed: the re-fetch drives it', async () => {
    const { user, payment } = await waiting();
    const body = forged(payment.id);
    yookassa.remoteStatus = 'succeeded';

    const res = await post(YOOKASSA, body);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length') ?? '0').toBe('0');
    const row = await reposOf(t).payments.getById(payment.id);
    expect(row).toMatchObject({ status: 'SUCCEEDED', wasRewarded: true });
    expect(row?.providerMetadata).toMatchObject({ remote_status: 'succeeded', webhook: body });
    const subscription = await reposOf(t).subscriptions.getActiveByUserId(user.id);
    expect(subscription?.endDate.getTime()).toBeGreaterThan(addDays(new Date(), 1).getTime());
    expect(subscription?.paymentMethodId).toBe('pm_forged');
    expect(yookassa.requests[0]).toMatchObject({ method: 'GET', path: '/payments/provider_payment_forged' });
  });

  it('a body the provider does not know changes nothing and answers 200', async () => {
    const { payment } = await waiting();
    const body = notification('payment.succeeded', { id: 'unknown', metadata: { app_payment_id: payment.id } });

    const res = await post(YOOKASSA, body);

    expect(res.status).toBe(200);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');
    expect(await reposOf(t).paymentEvents.getByPaymentId(payment.id)).toEqual([]);
  });

  it('the app payment id comes from the provider, not the body', async () => {
    const { payment } = await waiting();
    const { payment: victim } = await waiting();
    const body = webhook(payment.id, 'succeeded');
    (body.object.metadata as Record<string, string>).app_payment_id = victim.id;
    yookassa.addPayment({ id: String(body.object.id), status: 'succeeded', metadata: { app_payment_id: payment.id } });

    await post(YOOKASSA, body);

    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('SUCCEEDED');
    expect((await reposOf(t).payments.getById(victim.id))?.status).toBe('WAITING_FOR_ACTION');
  });

  it('a re-fetched payment without our metadata is ignored', async () => {
    yookassa.addPayment({ id: 'theirs', status: 'succeeded' });

    const res = await post(YOOKASSA, notification('payment.succeeded', { id: 'theirs' }));

    expect(res.status).toBe(200);
  });

  it.each([
    ['not an object', [1, 2]],
    ['no type', { event: 'payment.succeeded', object: { id: 'x' } }],
    ['the wrong type', { type: 'other', event: 'payment.succeeded', object: { id: 'x' } }],
    ['an empty object', { type: 'notification', event: 'payment.succeeded', object: {} }],
    ['an object that is no object', { type: 'notification', event: 'payment.succeeded', object: 'x' }],
  ])('a notification with %s changes nothing and answers 200', async (_name, body) => {
    const before = (await dlq()).length;

    const res = await post(YOOKASSA, body);

    expect(res.status).toBe(200);
    expect(await dlq()).toHaveLength(before);
  });

  it('a notification with no object at all is an unknown error, stored', async () => {
    const res = await post(YOOKASSA, { type: 'notification', event: 'payment.succeeded' });

    expect(res.status).toBe(500);
    expect(await lastDlq()).toMatchObject({ provider: 'YOOKASSA', errorType: 'unknown' });
  });
});

describe('the state machine', () => {
  it('a repeated webhook rewards once and logs both', async () => {
    const { user, payment } = await waiting();
    const body = webhook(payment.id, 'succeeded', { payment_method: { id: 'pm_1', type: 'bank_card' } });

    await post(YOOKASSA, body);
    const end = (await reposOf(t).subscriptions.getActiveByUserId(user.id))?.endDate;
    await post(YOOKASSA, body);

    expect((await reposOf(t).subscriptions.getActiveByUserId(user.id))?.endDate).toEqual(end);
    expect(events(t, 'payment_succeeded')).toHaveLength(1);
    expect(await reposOf(t).paymentEvents.getByPaymentId(payment.id)).toHaveLength(2);
  });

  it('a late canceled cannot overwrite a final state', async () => {
    const { payment } = await waiting({ status: PaymentStatus.SUCCEEDED });

    await post(YOOKASSA, webhook(payment.id, 'canceled'));

    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('SUCCEEDED');
    expect(events(t, 'payment_failed')).toEqual([]);
    const [event] = await reposOf(t).paymentEvents.getByPaymentId(payment.id);
    expect(event?.eventType).toBe(PaymentEventType.PAYMENT_CANCELED);
  });

  it('waiting_for_capture keeps the payment waiting; pending leaves it as it is', async () => {
    const { payment } = await waiting();

    await post(YOOKASSA, webhook(payment.id, 'waiting_for_capture'));
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');

    await post(YOOKASSA, webhook(payment.id, 'pending'));
    const log = await reposOf(t).paymentEvents.getByPaymentId(payment.id);
    expect(log.map((e) => e.eventType)).toEqual(['PROVIDER_RESPONSE', 'PROVIDER_RESPONSE']);
  });

  it('a payment with no method falls back to the body for the saved card', async () => {
    const { user, payment } = await waiting();
    const body = webhook(payment.id, 'succeeded');
    yookassa.addPayment({ id: String(body.object.id), status: 'succeeded', metadata: { app_payment_id: payment.id } });
    const withCard = notification('payment.succeeded', { ...body.object, payment_method: { id: 'pm_body' } });

    await post(YOOKASSA, withCard);

    const subscription = await reposOf(t).subscriptions.getActiveByUserId(user.id);
    expect(subscription?.recurringDetails.payment_method_id).toBe('pm_body');
  });
});

describe('the row lock', () => {
  it('concurrent webhooks reward once', async () => {
    const { user, payment } = await waiting();
    const body = webhook(payment.id, 'succeeded', { payment_method: { id: 'pm_1', type: 'bank_card' } });

    const answers = await Promise.all([post(YOOKASSA, body), post(YOOKASSA, body), post(YOOKASSA, body)]);

    expect(answers.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(events(t, 'payment_succeeded')).toHaveLength(1);
    const [subscription, ...others] = await reposOf(t).subscriptions.getByUserId(user.id);
    expect(others).toEqual([]);
    expect(subscription?.endDate.getTime()).toBeLessThan(addDays(new Date(), 31).getTime());
  });

  it('a webhook racing the status poll rewards once', async () => {
    const { user, payment } = await waiting({ providerPaymentId: 'pay_race' });
    const object = {
      id: 'pay_race',
      status: 'succeeded',
      metadata: { app_payment_id: payment.id },
      payment_method: { id: 'pm_1', type: 'bank_card' },
    };
    yookassa.addPayment(object);

    const [hook, poll] = await Promise.all([
      post(YOOKASSA, notification('payment.succeeded', object)),
      t.client.get(`/payments/${payment.id}/status`, { headers: asUser(user) }),
    ]);

    expect([hook.status, poll.status]).toEqual([200, 200]);
    expect(await reposOf(t).payments.getById(payment.id)).toMatchObject({ status: 'SUCCEEDED', wasRewarded: true });
    expect(events(t, 'payment_succeeded')).toHaveLength(1);
    expect(await reposOf(t).subscriptions.getByUserId(user.id)).toHaveLength(1);
  });
});

describe('is_recurring', () => {
  it('a first purchase stays a purchase after the webhook', async () => {
    const { payment } = await waiting({ isRecurring: false });

    const res = await post(
      YOOKASSA,
      webhook(payment.id, 'succeeded', {
        metadata: { app_payment_id: payment.id, is_recurring: 'true' },
        payment_method: { id: 'pm_1', type: 'bank_card' },
      }),
    );

    expect(res.status).toBe(200);
    expect(await reposOf(t).payments.getById(payment.id)).toMatchObject({ status: 'SUCCEEDED', isRecurring: false });
  });

  it('a renewal stays a renewal after the webhook', async () => {
    const { payment } = await waiting({ isRecurring: true });

    await post(YOOKASSA, webhook(payment.id, 'succeeded', { payment_method: { id: 'pm_1', type: 'bank_card' } }));

    expect((await reposOf(t).payments.getById(payment.id))?.isRecurring).toBe(true);
  });
});

describe('analytics', () => {
  it('a succeeded payment says how it was paid', async () => {
    const { payment } = await waiting({ isRecurring: false });

    await post(YOOKASSA, webhook(payment.id, 'succeeded', { payment_method: { id: 'pm_1', type: 'sbp' } }));

    const [succeeded] = events(t, 'payment_succeeded');
    expect(succeeded?.properties).toMatchObject({ payment_method_type: 'sbp', provider_id: 'YOOKASSA' });
  });

  it('a canceled payment reports the reason', async () => {
    const { payment } = await waiting({ isRecurring: false });

    await post(
      YOOKASSA,
      webhook(payment.id, 'canceled', {
        payment_method: { id: 'pm_2', type: 'bank_card' },
        cancellation_details: { party: 'payment_network', reason: 'insufficient_funds' },
      }),
    );

    const [failed] = events(t, 'payment_failed');
    expect(failed?.properties).toMatchObject({
      status: 'CANCELED',
      payment_method_type: 'bank_card',
      reason: 'insufficient_funds',
      party: 'payment_network',
    });
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('CANCELED');
  });

  it('Stars payments are marked as Stars', () => {
    expect(paymentMethodType({ providerId: PaymentProvider.TELEGRAM_STARS }, {})).toBe('telegram_stars');
    expect(paymentMethodType({ providerId: PaymentProvider.YOOKASSA }, { payment_method_type: 'bank_card' })).toBe(
      'bank_card',
    );
    expect(paymentMethodType({ providerId: PaymentProvider.YOOKASSA }, null)).toBeNull();
  });
});

describe('refund.* notifications', () => {
  const refundPayload = (refundId: string, providerPaymentId: string) =>
    notification('refund.succeeded', {
      id: refundId,
      amount: { value: '100.00', currency: 'RUB' },
      status: 'succeeded',
      created_at: '2026-04-05T18:29:34.489Z',
      payment_id: providerPaymentId,
      description: 'Bug, double charge',
      refund_authorization_details: { rrn: '000000000000' },
    });

  const paidSubscription = async () => {
    const providerPaymentId = `yk-${randomUUID().slice(0, 12)}`;
    const user = await createUser(t.db);
    const subscription = await makeSubscription(t, user.id, {
      endDate: addDays(new Date(), 300),
      productId: 'YEAR_SUB',
    });
    const payment = await makePayment(t, user.id, { productId: 'YEAR_SUB', providerPaymentId });
    return { paymentId: payment.id, subId: subscription.id, providerPaymentId };
  };

  const refundStub = (providerPaymentId: string, overrides: Record<string, unknown> = {}) => {
    yookassa.remoteRefund = {
      payment_id: providerPaymentId,
      status: 'succeeded',
      amount: { value: '100.00', currency: 'RUB' },
      description: 'Bug, double charge',
      ...overrides,
    };
    return () => {
      yookassa.remoteRefund = null;
    };
  };

  it('a full refund marks the payment REFUNDED and leaves the subscription', async () => {
    const { paymentId, subId, providerPaymentId } = await paidSubscription();
    const unstub = refundStub(providerPaymentId);

    const res = await post(YOOKASSA, refundPayload(`rf-${randomUUID()}`, providerPaymentId));

    unstub();
    expect(res.status).toBe(200);
    const payment = await reposOf(t).payments.getById(paymentId);
    expect(payment?.status).toBe('REFUNDED');
    expect(payment?.providerMetadata).toMatchObject({ refund: { description: 'Bug, double charge' } });
    const log = await reposOf(t).paymentEvents.getByPaymentId(paymentId);
    expect(log.map((e) => e.eventType)).toContain(PaymentEventType.PAYMENT_REFUNDED);
    // access is the refunder's call
    expect((await reposOf(t).subscriptions.getById(subId))?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(events(t, 'payment_refunded')[0]?.properties.payment_id).toBe(paymentId);
    const message = adminMessages(t).find((m) => m.includes('Refund'));
    expect(message).toContain('Nothing was taken back');
  });

  it('a repeated refund webhook changes nothing', async () => {
    const { paymentId, providerPaymentId } = await paidSubscription();
    const unstub = refundStub(providerPaymentId);
    const payload = refundPayload(`rf-${randomUUID()}`, providerPaymentId);

    await post(YOOKASSA, payload);
    await post(YOOKASSA, payload);

    unstub();
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('REFUNDED');
    expect(events(t, 'payment_refunded')).toHaveLength(1);
  });

  it('a partial refund keeps the payment SUCCEEDED, with the refund recorded', async () => {
    const { paymentId, providerPaymentId } = await paidSubscription();
    const unstub = refundStub(providerPaymentId, { amount: { value: '40.00', currency: 'RUB' } });

    await post(YOOKASSA, refundPayload(`rf-${randomUUID()}`, providerPaymentId));

    unstub();
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
    expect(events(t, 'payment_refunded')).toEqual([]);
  });

  it('a refund of an unknown payment does not crash', async () => {
    const unstub = refundStub('yk-not-ours');

    const res = await post(YOOKASSA, refundPayload('rf-unknown', 'yk-not-ours'));

    unstub();
    expect(res.status).toBe(200);
  });

  it('a refund the provider does not confirm changes nothing', async () => {
    const { paymentId, providerPaymentId } = await paidSubscription();

    const res = await post(YOOKASSA, refundPayload('rf-unconfirmed', providerPaymentId));

    expect(res.status).toBe(200);
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
  });
});

describe('error branches', () => {
  /** Run `processCallback` as `callback` says, on the request's own services. */
  const stubCallback = (callback: (repos: TestServices['repos']) => Promise<void>) => {
    const original = t.api.state.servicesClass;
    restore = () => {
      t.api.state.servicesClass = original;
    };
    t.api.state.servicesClass = class extends (original as unknown as typeof TestServices) {
      override get payments() {
        const payments = super.payments;
        payments.processCallback = () => callback(this.repos);
        return payments;
      }
    } as never;
  };

  let restore = () => {};

  afterEach(() => restore());

  it('invalid JSON is a 400, with the reason', async () => {
    const res = await t.client.request(YOOKASSA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/^Invalid JSON payload: /);
  });

  it('an empty body is a 400', async () => {
    const res = await t.client.request(STARS, { method: 'POST', headers: STARS_HEADERS });

    expect(res.status).toBe(400);
  });

  it.each([
    ['a permanent error', new PaymentValueError('Product X not found'), 400, 'permanent', 'Product X not found'],
    ['a transient one', new PaymentValueError('Try again'), 500, 'transient', 'Internal server error'],
    ['an unknown one', new Error('boom'), 500, 'unknown', 'Internal server error'],
    [
      'an infrastructure failure',
      Object.assign(new Error('Connection is closed.'), { code: 'CONNECTION_CLOSED' }),
      503,
      'infrastructure',
      'Service temporarily unavailable',
    ],
  ])('%s is stored and answered', async (_name, error, status, errorType, text) => {
    stubCallback(() => Promise.reject(error));
    const body = { type: 'notification', event: 'payment.succeeded', object: { id: randomUUID() } };

    for (const [path, provider] of [
      [YOOKASSA, 'YOOKASSA'],
      [STARS, 'TELEGRAM_STARS'],
    ] as const) {
      const res = await post(path, body);

      expect(res.status).toBe(status);
      expect(await res.text()).toBe(text);
      expect(await lastDlq()).toMatchObject({
        provider,
        payload: body,
        errorMessage: error.message,
        errorType,
      });
    }
  });

  it('what the callback wrote before failing commits with the DLQ row, as in Python', async () => {
    const { payment } = await waiting();
    const body = webhook(payment.id, 'succeeded');
    stubCallback(async (repos) => {
      await repos.payments.update(payment.id, { providerMetadata: { reached: true } });
      throw new Error('after the write');
    });

    const res = await post(YOOKASSA, body);

    expect(res.status).toBe(500);
    expect((await reposOf(t).payments.getById(payment.id))?.providerMetadata).toEqual({ reached: true });
  });
});

describe('signature checks', () => {
  const state = webhookState;

  afterEach(() => {
    state().yookassaWebhookSecret = undefined;
    state().telegramWebhookSecret = STARS_SECRET;
  });

  it("YooKassa's is off by default, as in Python", async () => {
    const res = await post(YOOKASSA, notification('payment.succeeded', { id: 'x' }));

    expect(res.status).toBe(200);
  });

  it('a valid YooKassa signature passes', async () => {
    state().yookassaWebhookSecret = 's3cret';
    const { payment } = await waiting();
    const body = webhook(payment.id, 'succeeded');
    const signature = createHmac('sha256', 's3cret').update(`notification&${body.object.id}&succeeded`).digest('hex');

    const res = await post(YOOKASSA, body, { authorization: `Bearer ${signature}` });

    expect(res.status).toBe(200);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('SUCCEEDED');
  });

  it('a bad YooKassa signature changes nothing: the router answers 500, stored as unknown', async () => {
    state().yookassaWebhookSecret = 's3cret';
    const { payment } = await waiting();
    const body = webhook(payment.id, 'succeeded');

    const res = await post(YOOKASSA, body, { authorization: 'Bearer forged' });

    expect(res.status).toBe(500);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');
    expect(await lastDlq()).toMatchObject({ errorMessage: 'Invalid webhook signature', errorType: 'unknown' });
  });

  it('a bad Telegram secret changes nothing either', async () => {
    state().telegramWebhookSecret = 's3cret';
    const user = await createUser(t.db);
    const payment = await makeInitialStarsPayment(t, user.id);

    const res = await post(
      STARS,
      { payload: `payment_${payment.id}`, successful_payment: { telegram_payment_charge_id: 'c' } },
      { 'x-telegram-bot-api-secret-token': 'wrong' },
    );

    expect(res.status).toBe(500);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');
    expect(await lastDlq()).toMatchObject({ errorMessage: 'Invalid webhook secret token' });
  });

  it('a right Telegram secret goes through', async () => {
    state().telegramWebhookSecret = 's3cret';
    const user = await createUser(t.db);
    const payment = await makeInitialStarsPayment(t, user.id);

    const res = await post(
      STARS,
      { payload: `payment_${payment.id}`, successful_payment: { telegram_payment_charge_id: 'c' } },
      { 'x-telegram-bot-api-secret-token': 's3cret' },
    );

    expect(res.status).toBe(200);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('SUCCEEDED');
  });
});

describe('the dormant Stars webhook', () => {
  it('routes the payload through processCallback', async () => {
    const user = await createUser(t.db);
    const payment = await makeInitialStarsPayment(t, user.id);

    const res = await post(STARS, {
      payload: `payment_${payment.id}`,
      successful_payment: { telegram_payment_charge_id: 'c1', is_recurring: true, is_first_recurring: true },
    });

    expect(res.status).toBe(200);
    expect(await inTransaction(t, (services) => services.subscriptions.hasActiveSubscription(user.id))).toBe(true);
  });

  it('a body with nothing to act on answers 200', async () => {
    expect((await post(STARS, { event: 'nothing' })).status).toBe(200);
    expect((await post(STARS, [1])).status).toBe(200);
  });
});

describe('the Stars webhook with no secret configured', () => {
  // Python checks the secret only when one is set, and none is: its route takes a forged successful_payment as paid
  beforeEach(() => {
    webhookState().telegramWebhookSecret = undefined;
  });

  afterEach(() => {
    webhookState().telegramWebhookSecret = STARS_SECRET;
  });

  it('is a 404, and a forged successful_payment grants nothing', async () => {
    const user = await createUser(t.db);
    const payment = await makeInitialStarsPayment(t, user.id);
    const before = (await dlq()).length;

    const res = await t.client.post(STARS, {
      payload: `payment_${payment.id}`,
      successful_payment: { telegram_payment_charge_id: 'forged' },
    });

    expect(res.status).toBe(404);
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');
    expect(await reposOf(t).subscriptions.getByUserId(user.id)).toEqual([]);
    expect(await dlq()).toHaveLength(before);
  });

  it('a forged renewal mints no payment and extends nothing', async () => {
    const user = await createUser(t.db);
    const payment = await makeInitialStarsPayment(t, user.id);
    webhookState().telegramWebhookSecret = STARS_SECRET;
    await post(STARS, {
      payload: `payment_${payment.id}`,
      successful_payment: { telegram_payment_charge_id: 'c1', is_recurring: true, is_first_recurring: true },
    });
    webhookState().telegramWebhookSecret = undefined;
    const end = (await reposOf(t).subscriptions.getActiveByUserId(user.id))?.endDate;

    for (const chargeId of ['forged_1', 'forged_2']) {
      const res = await t.client.post(STARS, {
        payload: `payment_${payment.id}`,
        successful_payment: { telegram_payment_charge_id: chargeId, is_recurring: true, is_first_recurring: false },
      });
      expect(res.status).toBe(404);
    }

    expect(await reposOf(t).payments.getByUserId(user.id)).toHaveLength(1);
    expect((await reposOf(t).subscriptions.getActiveByUserId(user.id))?.endDate).toEqual(end);
  });
});
