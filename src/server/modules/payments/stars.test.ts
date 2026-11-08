/**
 * Telegram Stars subscription lifecycle: initial grant, auto-renewal, idempotency, cancel, refunds. Port of Python gramkit's
 * app's `test_telegram_stars_renewal.py`, driving `processCallback` as the bot's `successful_payment` handler does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PaymentProvider, PaymentStatus, SubscriptionStatus } from '../../db/schema';
import { RefundNotAllowedException } from '../../lib/errors';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { products } from './products';
import { isNativeStarsSubscription } from './providers/telegram-stars';
import { ProviderRefundError } from './service';
import {
  adminMessages,
  cleanMoneyTables,
  createStarsUser,
  events,
  inTransaction,
  makeInitialStarsPayment,
  makePayment,
  reposOf,
  resetFakes,
  STARS,
} from './test-helpers';
import { addDays } from './utils';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

afterEach(async () => {
  resetFakes(t);
  await cleanMoneyTables(t);
});

interface ChargeOptions {
  chargeId: string;
  isFirstRecurring: boolean;
  isRecurring?: boolean;
}

/** What the bot's `successful_payment` handler forwards. Telegram always re-sends the ORIGINAL invoice payload. */
function successfulPaymentPayload(
  originalId: string,
  { chargeId, isFirstRecurring, isRecurring = true }: ChargeOptions,
) {
  return {
    successful_payment: {
      currency: 'XTR',
      total_amount: 100,
      invoice_payload: `payment_${originalId}`,
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: `prov_${chargeId}`,
      subscription_expiration_date: null,
      is_recurring: isRecurring,
      is_first_recurring: isFirstRecurring,
    },
    payload: `payment_${originalId}`,
    from_user: {},
    is_recurring: isRecurring,
    is_first_recurring: isFirstRecurring,
  };
}

/** What the bot's refunded_payment handler forwards: a renewal's refund still names the first payment. */
const refundedPaymentPayload = (originalId: string, chargeId: string) => ({
  refunded_payment: {
    currency: 'XTR',
    total_amount: 100,
    invoice_payload: `payment_${originalId}`,
    telegram_payment_charge_id: chargeId,
    provider_payment_charge_id: `prov_${chargeId}`,
  },
  payload: `payment_${originalId}`,
});

const callback = (payload: Record<string, unknown>) =>
  inTransaction(t, (services) => services.payments.processCallback(payload, STARS));

const charge = (originalId: string, options: ChargeOptions) => callback(successfulPaymentPayload(originalId, options));

const renew = (originalId: string, chargeId: string) => charge(originalId, { chargeId, isFirstRecurring: false });

const buyOneTime = (paymentId: string, chargeId: string) =>
  charge(paymentId, { chargeId, isFirstRecurring: false, isRecurring: false });

/** The initial Stars subscription charge. */
async function grantInitial(telegramId: number) {
  const user = await createStarsUser(t, telegramId);
  const payment = await makeInitialStarsPayment(t, user.id);
  await charge(payment.id, { chargeId: 'charge_1', isFirstRecurring: true });
  return { userId: user.id, paymentId: payment.id };
}

const activeSub = (userId: string) => reposOf(t).subscriptions.getActiveByUserId(userId);

const cancel = async (userId: string) => {
  t.fakes.bot.clear();
  await inTransaction(t, (services) => services.subscriptions.cancelSubscription(userId, 'notUsing'));
  return t.fakes.bot.sent('editUserStarSubscription');
};

const refund = (paymentId: string) => inTransaction(t, (services) => services.payments.refundPayment(paymentId));

describe('initial charge', () => {
  it('activates a subscription and stores the telegram charge id', async () => {
    const { userId, paymentId } = await grantInitial(1001);

    const subscription = await activeSub(userId);
    expect(subscription).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      productId: 'MONTH_SUB_V3',
      providerId: PaymentProvider.TELEGRAM_STARS,
    });
    expect(subscription?.recurringDetails.telegram_payment_charge_id).toBe('charge_1');

    const payment = await reposOf(t).payments.getById(paymentId);
    expect(payment).toMatchObject({
      status: PaymentStatus.SUCCEEDED,
      wasRewarded: true,
      subscriptionId: subscription?.id,
      isRecurring: false, // the user's own purchase, even though Telegram flags it recurring
    });
    expect(payment?.providerMetadata).toMatchObject({
      telegram_payment_charge_id: 'charge_1',
      provider_payment_charge_id: 'prov_charge_1',
      is_renewal: false,
    });
  });
});

describe('auto-renewal', () => {
  it('mints a fresh payment row and extends the end date', async () => {
    const { userId, paymentId } = await grantInitial(1002);
    const before = await activeSub(userId);

    await renew(paymentId, 'charge_2');

    const after = await activeSub(userId);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(after?.endDate.getTime()).toBeGreaterThan(before?.endDate.getTime() ?? 0);
    expect(after?.recurringDetails.telegram_payment_charge_id).toBe('charge_2'); // the latest id wins

    const renewal = await reposOf(t).payments.getByProviderPaymentId('charge_2');
    expect(renewal?.id).not.toBe(paymentId);
    expect(renewal).toMatchObject({ status: 'SUCCEEDED', isRecurring: true, subscriptionId: after?.id });
    expect(renewal?.providerMetadata.renewed_from_payment_id).toBe(paymentId);
    expect(await reposOf(t).payments.getByUserId(userId)).toHaveLength(2);
  });

  it('a redelivered renewal neither extends nor charges twice', async () => {
    const { userId, paymentId } = await grantInitial(1003);
    await renew(paymentId, 'charge_2');
    const end = (await activeSub(userId))?.endDate;

    await renew(paymentId, 'charge_2');

    expect((await activeSub(userId))?.endDate).toEqual(end);
    expect(await reposOf(t).payments.getByUserId(userId)).toHaveLength(2);
  });

  it('concurrent deliveries of one renewal record and reward it once', async () => {
    // Webhook mode runs updates concurrently: Telegram redelivers a renewal grammY timed out on while the first run is
    // still in its transaction
    const { userId, paymentId } = await grantInitial(1013);
    const before = (await activeSub(userId))?.endDate.getTime() ?? 0;

    await Promise.all(Array.from({ length: 4 }, () => renew(paymentId, 'charge_2')));

    const rows = await reposOf(t).payments.getByUserId(userId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.providerPaymentId === 'charge_2')).toHaveLength(1);
    const after = (await activeSub(userId))?.endDate.getTime() ?? 0;
    expect(Math.round((after - before) / 86_400_000)).toBe(30);
  });
});

describe('cancel', () => {
  it('tells Telegram to stop, and a late renewal cannot resurrect the sub', async () => {
    const { userId, paymentId } = await grantInitial(1004);

    const [edit] = await cancel(userId);

    expect(edit?.payload).toEqual({ user_id: 1004, telegram_payment_charge_id: 'charge_1', is_canceled: true });
    const canceled = await activeSub(userId);
    expect(canceled?.status).toBe(SubscriptionStatus.CANCELED);

    await renew(paymentId, 'charge_2');

    const after = await activeSub(userId);
    expect(after?.status).toBe(SubscriptionStatus.CANCELED);
    expect(after?.endDate).toEqual(canceled?.endDate);
  });

  it('a user buying again after a cancel reactivates the sub', async () => {
    const { userId } = await grantInitial(1005);
    await cancel(userId);
    const canceled = await activeSub(userId);

    const repurchase = await makeInitialStarsPayment(t, userId);
    await charge(repurchase.id, { chargeId: 'charge_new', isFirstRecurring: true });

    const after = await activeSub(userId);
    expect(after?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(after?.endDate.getTime()).toBeGreaterThan(canceled?.endDate.getTime() ?? 0);
  });

  it('sends the FIRST charge id, not the latest renewal', async () => {
    const { userId, paymentId } = await grantInitial(1006);
    await renew(paymentId, 'charge_2');

    const subscription = await activeSub(userId);
    expect(subscription?.recurringDetails.telegram_payment_charge_id).toBe('charge_2');
    expect(subscription?.recurringDetails.telegram_subscription_charge_id).toBe('charge_1');

    const [edit] = await cancel(userId);
    expect(edit?.payload.telegram_payment_charge_id).toBe('charge_1');
  });

  it('a renewal landing after a canceled sub ended does not create a new sub', async () => {
    const { userId, paymentId } = await grantInitial(1007);
    await cancel(userId);
    const subscription = await activeSub(userId);
    await reposOf(t).subscriptions.update(subscription?.id, { endDate: addDays(new Date(), -1) });

    await renew(paymentId, 'charge_2');

    const all = await reposOf(t).subscriptions.getByUserId(userId);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe(SubscriptionStatus.CANCELED);
  });

  it('a legacy sub with no stored charge id alerts the admins, and the DB cancel still succeeds', async () => {
    const user = await createStarsUser(t, 1008);
    await reposOf(t).subscriptions.create({
      userId: user.id,
      productId: 'MONTH_SUB_V3',
      providerId: PaymentProvider.TELEGRAM_STARS,
      status: SubscriptionStatus.ACTIVE,
      currency: 'XTR',
      startDate: new Date(),
      endDate: addDays(new Date(), 30),
      recurringDetails: {},
    });

    const edits = await cancel(user.id);

    expect(edits).toEqual([]);
    expect(adminMessages(t).some((m) => m.includes('Cancel not propagated'))).toBe(true);
    expect((await activeSub(user.id))?.status).toBe(SubscriptionStatus.CANCELED);
  });

  it('a provider failure alerts the admins and the user is still canceled', async () => {
    const { userId } = await grantInitial(1009);
    t.fakes.bot.clear();
    t.fakes.bot.failNext('editUserStarSubscription', { error_code: 400, description: 'Bad Request: <nope>' });

    const result = await inTransaction(t, (services) => services.subscriptions.cancelSubscription(userId));

    expect(result.status).toBe(SubscriptionStatus.CANCELED);
    const alert = adminMessages(t).find((m) => m.includes('Cancel not propagated'));
    expect(alert).toContain('&lt;nope&gt;');
    expect(alert).toContain('#critical #cancel');
  });
});

describe('one-time Stars plans', () => {
  it('the yearly plan grants about 365 days and is not Telegram-managed', async () => {
    const user = await createStarsUser(t, 2001);
    const payment = await makeInitialStarsPayment(t, user.id, 'YEAR_SUB_V3');

    await buyOneTime(payment.id, 'year_charge_1');

    const subscription = await activeSub(user.id);
    expect(subscription).toMatchObject({ status: SubscriptionStatus.ACTIVE, productId: 'YEAR_SUB_V3' });
    expect(subscription?.recurringDetails.telegram_subscription_managed).toBe(false);
    expect(subscription?.recurringDetails).not.toHaveProperty('telegram_subscription_charge_id');
    expect(await reposOf(t).payments.getById(payment.id)).toMatchObject({ status: 'SUCCEEDED', wasRewarded: true });
  });

  it('canceling one does not call Telegram and raises no alert', async () => {
    const user = await createStarsUser(t, 2002);
    const payment = await makeInitialStarsPayment(t, user.id, 'YEAR_SUB_V3');
    await buyOneTime(payment.id, 'year_charge_1');

    const edits = await cancel(user.id);

    expect(edits).toEqual([]);
    expect(adminMessages(t).some((m) => m.includes('Cancel not propagated'))).toBe(false);
    expect((await activeSub(user.id))?.status).toBe(SubscriptionStatus.CANCELED);
  });

  it('the weekly plan grants seven days, not managed', async () => {
    const user = await createStarsUser(t, 3002);
    const payment = await makeInitialStarsPayment(t, user.id, 'WEEK_SUB_V3');

    await buyOneTime(payment.id, 'week_1');

    const subscription = await activeSub(user.id);
    expect(subscription?.productId).toBe('WEEK_SUB_V3');
    expect(subscription?.recurringDetails.telegram_subscription_managed).toBe(false);
  });

  it('a non-subscription product stores no recurring details', async () => {
    const user = await createStarsUser(t, 3004);
    const payment = await makeInitialStarsPayment(t, user.id, 'TEST_ONETIME');

    await buyOneTime(payment.id, 'one_1');

    // TEST_ONETIME has the default reward: no subscription, but the payment is finalized and rewarded
    expect(await reposOf(t).subscriptions.getByUserId(user.id)).toEqual([]);
    expect(await reposOf(t).payments.getById(payment.id)).toMatchObject({ status: 'SUCCEEDED', wasRewarded: true });
  });
});

describe('invoices', () => {
  const startStars = (userId: string, productId: string, locale: string | null = null) =>
    inTransaction(t, (services) => services.payments.startPayment(userId, productId, 'XTR', STARS, null, locale));

  it('a recurring plan that is not 30 days long is a one-time charge, with its days in the description', async () => {
    const user = await createUser(t.db);

    await startStars(user.id, 'YEAR_SUB_V3');

    const [call] = t.fakes.bot.sent('createInvoiceLink');
    expect(call?.payload).not.toHaveProperty('subscription_period');
    expect(call?.payload.description).toBe('Purchase of Yearly Subscription - 365 days access');
  });

  it('the payment sheet speaks the language of the product', async () => {
    const user = await createUser(t.db);
    const product = products.getProduct('MONTH_SUB_V3');
    if (!product) throw new Error('no MONTH_SUB_V3');
    product.invoiceText = (locale) => (locale === 'ru' ? ['Подписка на месяц', 'На 30 дней'] : null);

    await startStars(user.id, 'MONTH_SUB_V3', 'ru').finally(() => {
      product.invoiceText = undefined;
    });

    const [call] = t.fakes.bot.sent('createInvoiceLink');
    expect(call?.payload).toMatchObject({
      title: 'Подписка на месяц',
      description: 'На 30 дней',
      subscription_period: 2592000,
    });
  });
});

describe('refunds', () => {
  it('refunding the only charge returns the Stars, ends access now and stops renewals', async () => {
    const { userId, paymentId } = await grantInitial(4001);

    await refund(paymentId);

    expect(t.fakes.bot.sent('refundStarPayment')[0]?.payload).toEqual({
      user_id: 4001,
      telegram_payment_charge_id: 'charge_1',
    });
    expect(t.fakes.bot.sent('editUserStarSubscription')[0]?.payload.is_canceled).toBe(true);
    const payment = await reposOf(t).payments.getById(paymentId);
    expect(payment?.status).toBe('REFUNDED');
    expect(payment?.providerMetadata.refunded_at).toMatch(/\+00:00$/);
    const [subscription] = await reposOf(t).subscriptions.getByUserId(userId);
    expect(subscription).toMatchObject({ status: 'EXPIRED', cancellationReason: 'refunded' });
    expect(subscription?.endDate.getTime()).toBeLessThanOrEqual(Date.now());
    expect(events(t, 'payment_refunded')).toHaveLength(1);
    expect(adminMessages(t).some((m) => m.includes('Access ended now'))).toBe(true);
    const log = await reposOf(t).paymentEvents.getByPaymentId(paymentId);
    expect(log.map((e) => e.eventType)).toContain('PAYMENT_REFUNDED');
  });

  it('refunding a renewal returns that charge and shortens access by one period', async () => {
    const { userId, paymentId } = await grantInitial(4002);
    await renew(paymentId, 'charge_2');
    const renewal = await reposOf(t).payments.getByProviderPaymentId('charge_2');
    const endBefore = (await activeSub(userId))?.endDate as Date;

    await refund(renewal?.id as string);

    expect(t.fakes.bot.sent('refundStarPayment')[0]?.payload.telegram_payment_charge_id).toBe('charge_2');
    const subscription = await activeSub(userId);
    expect(subscription?.status).toBe(SubscriptionStatus.CANCELED); // access left, renewals stopped
    expect(subscription?.endDate).toEqual(addDays(endBefore, -30));
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
  });

  it('a card payment or an unpaid one cannot be refunded from here', async () => {
    const user = await createUser(t.db);
    const card = await makePayment(t, user.id, { productId: 'MONTH_SUB_V3' });
    const unpaid = await makeInitialStarsPayment(t, user.id);

    await expect(refund(card.id)).rejects.toThrow(RefundNotAllowedException);
    await expect(refund(unpaid.id)).rejects.toThrow(RefundNotAllowedException);

    expect(t.fakes.bot.sent('refundStarPayment')).toEqual([]);
    expect((await reposOf(t).payments.getById(card.id))?.status).toBe('SUCCEEDED');
  });

  it('a provider refusal throws ProviderRefundError and the transaction rolls back', async () => {
    const { userId, paymentId } = await grantInitial(4004);
    t.fakes.bot.failNext('refundStarPayment', { error_code: 400, description: 'CHARGE_ALREADY_REFUNDED' });

    await expect(refund(paymentId)).rejects.toThrow(ProviderRefundError);

    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
    expect((await activeSub(userId))?.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('a refund notice for an unpaid payment changes nothing', async () => {
    const user = await createStarsUser(t, 4005);
    const payment = await makeInitialStarsPayment(t, user.id);

    await callback({
      refunded_payment: { telegram_payment_charge_id: 'never_recorded', invoice_payload: `payment_${payment.id}` },
      payload: `payment_${payment.id}`,
    });

    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('WAITING_FOR_ACTION');
    expect(events(t, 'payment_refunded')).toEqual([]);
  });

  it('a refund we have not recorded takes back access; a redelivery is a no-op', async () => {
    const { userId, paymentId } = await grantInitial(4003);

    await callback(refundedPaymentPayload(paymentId, 'charge_1'));
    await callback(refundedPaymentPayload(paymentId, 'charge_1'));

    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('REFUNDED');
    const [subscription] = await reposOf(t).subscriptions.getByUserId(userId);
    expect(subscription).toMatchObject({ status: 'EXPIRED', cancellationReason: 'refunded' });
    expect(subscription?.recurringDetails.telegram_subscription_canceled).toBe(true);
    expect(t.fakes.bot.sent('editUserStarSubscription')).toHaveLength(1);
    expect(t.fakes.bot.sent('refundStarPayment')).toEqual([]); // it's a notice: nothing to refund again
    expect(events(t, 'payment_refunded')).toHaveLength(1);
    expect(adminMessages(t).filter((m) => m.includes('Access ended now'))).toHaveLength(1);
  });

  it('a refund call that times out is finished by the notice', async () => {
    const { userId, paymentId } = await grantInitial(4006);
    t.fakes.bot.failNext('refundStarPayment', { error_code: 500, description: 'Request timeout' });

    await expect(refund(paymentId)).rejects.toThrow(ProviderRefundError);
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED'); // rolled back

    await callback(refundedPaymentPayload(paymentId, 'charge_1'));

    expect(t.fakes.bot.sent('editUserStarSubscription')[0]?.payload.telegram_payment_charge_id).toBe('charge_1');
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('REFUNDED');
    const [subscription] = await reposOf(t).subscriptions.getByUserId(userId);
    expect(subscription?.status).toBe('EXPIRED');
    expect(events(t, 'payment_refunded')).toHaveLength(1);
  });

  it('the notice for a renewal finds the renewal row and shortens access by one period', async () => {
    const { userId, paymentId } = await grantInitial(4007);
    await renew(paymentId, 'charge_2');
    const endBefore = (await activeSub(userId))?.endDate as Date;

    await callback(refundedPaymentPayload(paymentId, 'charge_2'));

    expect((await reposOf(t).payments.getByProviderPaymentId('charge_2'))?.status).toBe('REFUNDED');
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
    const subscription = await activeSub(userId);
    expect(subscription?.status).toBe(SubscriptionStatus.CANCELED);
    expect(subscription?.endDate).toEqual(addDays(endBefore, -30));
  });

  it('the notice for an unrecorded charge marks nothing and alerts the owner', async () => {
    const { userId, paymentId } = await grantInitial(4008);
    t.fakes.bot.clear();

    await callback(refundedPaymentPayload(paymentId, 'charge_lost'));

    expect(t.fakes.bot.sent('editUserStarSubscription')).toEqual([]);
    expect((await reposOf(t).payments.getById(paymentId))?.status).toBe('SUCCEEDED');
    expect((await activeSub(userId))?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(events(t, 'payment_refunded')).toEqual([]);
    expect(adminMessages(t).some((m) => m.includes('unknown charge') && m.includes('charge_lost'))).toBe(true);
  });

  it('a product can take back its own reward', async () => {
    const user = await createStarsUser(t, 4009);
    const payment = await makeInitialStarsPayment(t, user.id, 'TEST_ONETIME');
    await buyOneTime(payment.id, 'one_2');
    await reposOf(t).payments.update(payment.id, {
      providerMetadata: { telegram_payment_charge_id: 'one_2' },
    });
    const product = products.getProduct('TEST_ONETIME');
    if (!product) throw new Error('no TEST_ONETIME');
    product.takeBack = async () => '3 unspent credits taken back.';

    await refund(payment.id).finally(() => {
      product.takeBack = undefined;
    });

    expect(adminMessages(t).some((m) => m.includes('3 unspent credits taken back.'))).toBe(true);
  });
});

describe('a native monthly sub under later purchases', () => {
  const buyWeeklyWithStars = async (userId: string) => {
    const payment = await makeInitialStarsPayment(t, userId, 'WEEK_SUB_V3');
    await buyOneTime(payment.id, 'week_charge');
  };

  const buyWeeklyByCard = async (userId: string) => {
    const payment = await makePayment(t, userId, { productId: 'WEEK_SUB_V3', isRecurring: false });
    await inTransaction(t, (services) =>
      services.subscriptions.topUpSubscription(userId, 'WEEK_SUB_V3', 7, payment, {
        payment_method_id: 'pm_card',
        is_renewal: false,
      }),
    );
  };

  it('the weekly plan in Stars merges into the row, and a cancel still stops the monthly at Telegram', async () => {
    const { userId } = await grantInitial(4101);
    await buyWeeklyWithStars(userId);

    const subscription = await activeSub(userId);
    expect(subscription?.productId).toBe('WEEK_SUB_V3');
    expect(subscription?.recurringDetails.telegram_subscription_managed).toBe(false);

    const [edit] = await cancel(userId);
    expect(edit?.payload).toEqual({ user_id: 4101, telegram_payment_charge_id: 'charge_1', is_canceled: true });
  });

  it("a plan by card makes the row YooKassa's; the cancel still reaches Telegram", async () => {
    const { userId } = await grantInitial(4102);
    await buyWeeklyByCard(userId);

    expect((await activeSub(userId))?.providerId).toBe(PaymentProvider.YOOKASSA);

    const [edit] = await cancel(userId);
    expect(edit?.payload.telegram_payment_charge_id).toBe('charge_1');
  });

  it('a native sub is canceled at Telegram once', async () => {
    const { userId } = await grantInitial(4103);
    expect(await cancel(userId)).toHaveLength(1);

    await buyWeeklyByCard(userId);
    expect((await activeSub(userId))?.status).toBe(SubscriptionStatus.ACTIVE);

    expect(await cancel(userId)).toEqual([]);
    expect(adminMessages(t).some((m) => m.includes('Cancel not propagated'))).toBe(false);
  });

  it('a new native sub after a cancel is canceled again, with its own first charge id', async () => {
    const { userId } = await grantInitial(4104);
    await cancel(userId);

    const repurchase = await makeInitialStarsPayment(t, userId);
    await charge(repurchase.id, { chargeId: 'charge_new', isFirstRecurring: true });

    const [edit] = await cancel(userId);
    expect(edit?.payload.telegram_payment_charge_id).toBe('charge_new');
  });
});

describe('isNativeStarsSubscription', () => {
  it.each([
    ['MONTH_SUB_V3', STARS, { telegram_subscription_charge_id: 'c1' }, true],
    // a merged one-time purchase replaced the product, the provider and the managed flag
    [
      'WEEK_SUB_V3',
      PaymentProvider.YOOKASSA,
      { telegram_subscription_charge_id: 'c1', telegram_subscription_managed: false },
      true,
    ],
    ['MONTH_SUB_V3', STARS, { telegram_subscription_charge_id: 'c1', telegram_subscription_canceled: true }, false],
    ['YEAR_SUB_V3', STARS, { telegram_payment_charge_id: 'y1', telegram_subscription_managed: false }, false],
    ['WEEK_SUB_V3', STARS, { telegram_payment_charge_id: 'w1', telegram_subscription_managed: false }, false],
    ['MONTH_SUB_V3', STARS, {}, true], // a monthly from before the first-charge id was stored
    ['MONTH_SUB_V3', PaymentProvider.YOOKASSA, { payment_method_id: 'pm' }, false],
  ])('%s on %s with %j: %s', (productId, providerId, recurringDetails, native) => {
    expect(isNativeStarsSubscription({ productId, providerId, recurringDetails }, products)).toBe(native);
  });
});

describe('malformed callbacks', () => {
  it('a payload with no payment reference is ignored', async () => {
    await expect(callback({ payload: 'something_else' })).resolves.toBeUndefined();
    await expect(callback({})).resolves.toBeUndefined();
  });

  it('a payment id that is no UUID is ignored and does not abort the transaction', async () => {
    const user = await createUser(t.db);
    await expect(
      inTransaction(t, async (services) => {
        await services.payments.processCallback({ payload: 'payment_garbage' }, STARS);
        await services.repos.users.update(user.id, { displayName: 'after' });
      }),
    ).resolves.toBeUndefined();
    expect((await reposOf(t).users.getById(user.id))?.displayName).toBe('after');
  });
});
