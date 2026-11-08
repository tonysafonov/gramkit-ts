/** The Telegram handlers through the real bot chain (Database, Services, Auth, ...) on a real database. */
import { randomUUID } from 'node:crypto';
import type { Bot } from 'grammy';
import { MemorySessionStorage } from 'grammy';
import type { Update, User } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext, BotSession } from '../../bot/context';
import { setupBot } from '../../bot/setup';
import { tgUser } from '../../bot/test-utils';
import { createDb, type DbClient } from '../../db/client';
import { PaymentStatus, SubscriptionStatus } from '../../db/schema';
import { Repos } from '../../repos';
import { createTestDatabase, type TestDatabase } from '../../testing/database';
import { createUser, nextTelegramId } from '../../testing/factories';
import { FakeBot } from '../../testing/fakes/bot';
import { FakePostHog } from '../../testing/fakes/posthog';
import { FakeProducer } from '../../testing/fakes/producer';
import { FakeQueue } from '../../testing/fakes/queue';
import { FakeRedis } from '../../testing/fakes/redis';
import { paymentsComposer } from './bot';
import { type Product, products } from './products';

let database: TestDatabase;
let db: DbClient;
let fake: FakeBot;
let queue: FakeQueue;
let bot: Bot<BotContext>;
let repos: Repos;
let updateId = 1000;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.config);
  fake = new FakeBot();
  queue = new FakeQueue();
  new FakePostHog().install();
  repos = new Repos(db.db as never);
  bot = setupBot(fake.bot as unknown as Bot<BotContext>, {
    db: db.db,
    clients: { producer: new FakeProducer(), redis: new FakeRedis(), queue },
    storage: new MemorySessionStorage<BotSession>(),
    composers: [paymentsComposer],
  });
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

beforeEach(() => fake.clear());

const preCheckout = (from: User, invoicePayload: string): Update => ({
  update_id: updateId++,
  pre_checkout_query: { id: 'q1', from, currency: 'XTR', total_amount: 100, invoice_payload: invoicePayload },
});

const message = (from: User, fields: Record<string, unknown>): Update =>
  ({
    update_id: updateId++,
    message: { message_id: updateId, date: 1_700_000_000, chat: { id: from.id, type: 'private' }, from, ...fields },
  }) as Update;

const successfulPayment = (invoicePayload: string, chargeId: string, flags: Record<string, boolean> = {}) => ({
  successful_payment: {
    currency: 'XTR',
    total_amount: 100,
    invoice_payload: invoicePayload,
    telegram_payment_charge_id: chargeId,
    provider_payment_charge_id: `prov_${chargeId}`,
    ...flags,
  },
});

/** A Telegram user with no row yet. */
const stranger = () => {
  const id = nextTelegramId();
  return tgUser({ id, username: `stranger_${id}` });
};

const answers = () => fake.sent('answerPreCheckoutQuery').map((call) => call.payload);

async function starsPayment(overrides: { productId?: string; telegramId?: number } = {}) {
  const telegramId = overrides.telegramId ?? nextTelegramId();
  const user = await createUser(db.db, { telegramId });
  const payment = await repos.payments.create({
    userId: user.id,
    productId: overrides.productId ?? 'MONTH_SUB_V3',
    providerId: 'TELEGRAM_STARS',
    amount: 100,
    currency: 'XTR',
    status: PaymentStatus.WAITING_FOR_ACTION,
    providerPaymentId: `tg_stars_${randomUUID()}`,
  });
  return { user, payment, from: tgUser({ id: telegramId, username: user.tgUsername ?? undefined }) };
}

describe('pre-checkout', () => {
  it('approves a payment of the user and records the query', async () => {
    const { payment, from } = await starsPayment();

    await bot.handleUpdate(preCheckout(from, `payment_${payment.id}`));

    expect(answers()).toEqual([{ pre_checkout_query_id: 'q1', ok: true }]);
    const row = await repos.payments.getById(payment.id);
    expect(row?.providerMetadata.pre_checkout_query_id).toBe('q1');
    expect(row?.status).toBe(PaymentStatus.WAITING_FOR_ACTION);
  });

  it.each([
    ['a foreign payload', 'order_1', 'Invalid payment reference'],
    ['a payload that is no UUID', 'payment_123', 'Invalid payment reference'],
    ['an unknown payment', `payment_${randomUUID()}`, 'Payment not found'],
  ])('rejects %s', async (_name, payload, errorMessage) => {
    await bot.handleUpdate(preCheckout(stranger(), payload));

    expect(answers()).toEqual([{ pre_checkout_query_id: 'q1', ok: false, error_message: errorMessage }]);
  });

  it('rejects a payment of another user', async () => {
    const { payment } = await starsPayment();

    await bot.handleUpdate(preCheckout(stranger(), `payment_${payment.id}`));

    expect(answers()).toEqual([{ pre_checkout_query_id: 'q1', ok: false, error_message: 'Unauthorized payment' }]);
  });

  it.each([
    ['ru', 'На сегодня хватит — завтра снова можно.'],
    ['en', "That's enough for today — try again tomorrow."],
  ])('rejects over the daily limit, in %s', async (languageCode, errorMessage) => {
    const product = products.getProduct('MONTH_SUB_V3');
    if (!product) throw new Error('no MONTH_SUB_V3');
    product.dailyPurchaseLimit = 1;
    const { user, payment, from } = await starsPayment();
    await repos.payments.create({
      userId: user.id,
      productId: 'MONTH_SUB_V3',
      providerId: 'TELEGRAM_STARS',
      amount: 100,
      currency: 'XTR',
      status: PaymentStatus.SUCCEEDED,
    });

    await bot.handleUpdate(preCheckout({ ...from, language_code: languageCode }, `payment_${payment.id}`));
    product.dailyPurchaseLimit = undefined;

    expect(answers()).toEqual([{ pre_checkout_query_id: 'q1', ok: false, error_message: errorMessage }]);
  });
});

describe('successful payment', () => {
  it('finalizes the payment and grants the subscription', async () => {
    const { user, payment, from } = await starsPayment();

    await bot.handleUpdate(
      message(
        from,
        successfulPayment(`payment_${payment.id}`, 'charge_1', { is_recurring: true, is_first_recurring: true }),
      ),
    );

    expect((await repos.payments.getById(payment.id))?.status).toBe(PaymentStatus.SUCCEEDED);
    const subscription = await repos.subscriptions.getActiveByUserId(user.id);
    expect(subscription?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subscription?.recurringDetails.telegram_subscription_charge_id).toBe('charge_1');
    expect(fake.sent('sendMessage')).toEqual([]);
  });

  it('forwards the flags: a renewal mints its own row', async () => {
    const { user, payment, from } = await starsPayment();
    const first = successfulPayment(`payment_${payment.id}`, 'c1', { is_recurring: true, is_first_recurring: true });
    await bot.handleUpdate(message(from, first));

    await bot.handleUpdate(message(from, successfulPayment(`payment_${payment.id}`, 'c2', { is_recurring: true })));

    expect((await repos.payments.getByProviderPaymentId('c2'))?.isRecurring).toBe(true);
    expect(await repos.payments.getByUserId(user.id)).toHaveLength(2);
  });

  it('ignores a foreign payload', async () => {
    const { from } = await starsPayment();

    await bot.handleUpdate(message(from, successfulPayment('order_1', 'charge_x')));

    expect(fake.sent('sendMessage')).toEqual([]);
  });

  it('a failure tells the user to contact support', async () => {
    const { payment, from } = await starsPayment();
    const product = products.getProduct('MONTH_SUB_V3') as Product;
    const reward = vi.spyOn(product, 'reward').mockRejectedValueOnce(new Error('boom'));

    await bot.handleUpdate(message(from, successfulPayment(`payment_${payment.id}`, 'c_fail')));

    reward.mockRestore();
    expect(fake.sent('sendMessage')[0]?.payload.text).toContain('contact support');
    expect((await repos.payments.getById(payment.id))?.status).toBe(PaymentStatus.WAITING_FOR_ACTION);
  });
});

describe('refunded payment', () => {
  it('marks the payment REFUNDED and takes back access', async () => {
    const { user, payment, from } = await starsPayment();
    await bot.handleUpdate(
      message(
        from,
        successfulPayment(`payment_${payment.id}`, 'c_ref', { is_recurring: true, is_first_recurring: true }),
      ),
    );

    await bot.handleUpdate(
      message(from, {
        refunded_payment: {
          currency: 'XTR',
          total_amount: 100,
          invoice_payload: `payment_${payment.id}`,
          telegram_payment_charge_id: 'c_ref',
          provider_payment_charge_id: 'prov_c_ref',
        },
      }),
    );

    expect((await repos.payments.getById(payment.id))?.status).toBe(PaymentStatus.REFUNDED);
    const [subscription] = await repos.subscriptions.getByUserId(user.id);
    expect(subscription?.status).toBe(SubscriptionStatus.EXPIRED);
  });
});
