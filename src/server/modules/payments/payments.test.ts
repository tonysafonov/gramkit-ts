/** Port of `BasePaymentTests`, the product protocol contracts and `test_protocol_migration.py`. */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../../config';
import { PaymentStatus, paymentEvents, payments } from '../../db/schema';
import { asUser, createTestApp, createUser, FakeYooKassa, type TestApp, type TestServices } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import {
  AVAILABLE_PRODUCTS,
  getProduct,
  LEGACY_PRODUCTS,
  Product,
  productPriceIn,
  products,
  TEST_PRODUCTS,
} from './products';
import { events, inTransaction, makePayment, reposOf, resetFakes } from './test-helpers';
import { parseUuid } from './utils';

const MONTHLY_PRODUCT_ID = 'MONTH_SUB_V3';
const SECOND_PRODUCT_ID = 'WEEK_SUB_V3';
const RETURN_URL = 'https://example.com/return';

interface ProductJson {
  id: string;
  name: string;
  price: number;
  currency: string;
  duration_days: number;
  is_recurring: boolean;
  prices: { currency: string; amount: number }[];
}

let t: TestApp<TestServices>;
const yookassa = new FakeYooKassa();
let headers: Record<string, string>;

const newUser = async () => {
  const user = await createUser(t.db);
  headers = asUser(user);
  return user;
};

const purchase = (body: Record<string, unknown>) =>
  t.client.post('/payments/start_purchase', { return_url: RETURN_URL, ...body }, { headers });

beforeAll(async () => {
  t = await createTestApp();
  yookassa.install();
  t.fakes.bot.bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    return (
      method === 'createInvoiceLink' && result.ok ? { ok: true, result: 'https://t.me/$invoice' } : result
    ) as typeof result;
  });
});

afterAll(async () => {
  yookassa.uninstall();
  await t.close();
});

afterEach(() => resetFakes(t));

describe('product listing', () => {
  it('GET /payments/products returns available products', async () => {
    await newUser();
    const res = await t.client.get('/payments/products', { headers });

    expect(res.status).toBe(200);
    const list = (await res.json()) as ProductJson[];
    expect(list.length).toBeGreaterThan(0);
  });

  it('products have all required fields and positive prices', async () => {
    await newUser();
    const res = await t.client.get('/payments/products', { headers });
    const list = (await res.json()) as ProductJson[];

    for (const product of list) {
      expect(Object.keys(product)).toEqual([
        'id',
        'name',
        'price',
        'currency',
        'duration_days',
        'is_recurring',
        'prices',
      ]);
      expect(product.price).toBeGreaterThan(0);
    }
    expect(list.find((p) => p.id === MONTHLY_PRODUCT_ID)).toEqual({
      id: 'MONTH_SUB_V3',
      name: 'Monthly Subscription',
      price: 555,
      currency: 'RUB',
      duration_days: 30,
      is_recurring: true,
      prices: [
        { currency: 'RUB', amount: 555 },
        { currency: 'USD', amount: 3.99 },
      ],
    });
  });

  it('excludes test products even in debug mode', async () => {
    await newUser();
    const res = await t.client.get('/payments/products', { headers });
    const ids = ((await res.json()) as ProductJson[]).map((p) => p.id);

    expect(ids).toEqual(Object.keys(AVAILABLE_PRODUCTS));
  });

  it('getAvailableProducts adds test products in debug mode only', async () => {
    const ids = await inTransaction(t, async (services) => services.payments.getAvailableProducts().map((p) => p.id));
    expect(ids).toEqual([...Object.keys(AVAILABLE_PRODUCTS), ...Object.keys(TEST_PRODUCTS)]);

    const debug = settings.debug;
    settings.debug = false;
    const released = await inTransaction(t, (services) => services.payments.getAvailableProductsAsync(null, 'USD'));
    settings.debug = debug;
    expect(released.map((p) => p.id)).toEqual(Object.keys(AVAILABLE_PRODUCTS));
    expect(released[0]).toMatchObject({ price: 1.99, currency: 'USD' });
  });
});

describe('YooKassa payment', () => {
  it('POST /payments/start_purchase initiates a payment: a token for the embedded widget, no redirect URL', async () => {
    await newUser();
    const res = await purchase({ product_id: MONTHLY_PRODUCT_ID, currency: 'RUB', provider_id: 'YOOKASSA' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.confirmation_token).toBeTruthy();
    expect(data.confirmation_url).toBeNull();
    expect(Object.keys(data)).toEqual(['payment_id', 'confirmation_token', 'confirmation_url', 'amount', 'currency']);
  });

  it('returns a payment_id for tracking, with the row in WAITING_FOR_ACTION and its events', async () => {
    const user = await newUser();
    const res = await purchase({ product_id: SECOND_PRODUCT_ID, currency: 'RUB', provider_id: 'YOOKASSA' });

    expect(res.status).toBe(200);
    const { payment_id: paymentId } = (await res.json()) as { payment_id: string };
    const [row] = await t.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(row).toMatchObject({
      userId: user.id,
      productId: SECOND_PRODUCT_ID,
      amount: 222,
      currency: 'RUB',
      status: 'WAITING_FOR_ACTION',
      isRecurring: false,
    });
    expect(row?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.providerPaymentId).toMatch(/^payment_test_/);
    const log = await t.db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId));
    expect(log.map((e) => e.eventType).sort()).toEqual(['PAYMENT_CREATED', 'PAYMENT_INITIATED']);
  });

  it('sends the request the SDK builds, with the persisted idempotency key', async () => {
    const user = await newUser();
    const res = await purchase({ product_id: MONTHLY_PRODUCT_ID, currency: 'RUB', locale: 'en-US' });
    const { payment_id: paymentId } = (await res.json()) as { payment_id: string };
    const [row] = await t.db.select().from(payments).where(eq(payments.id, paymentId));

    const request = yookassa.requests.at(-1);
    expect(request?.idempotenceKey).toBe(row?.idempotencyKey);
    expect(request?.body).toEqual({
      amount: { value: '555.00', currency: 'RUB' },
      capture: true,
      receipt: {
        customer: { email: 'test@example.com' },
        items: [
          {
            description: 'Monthly Subscription',
            quantity: '1.0',
            amount: { value: '555.00', currency: 'RUB' },
            vat_code: 1,
          },
        ],
      },
      metadata: { app_payment_id: paymentId, is_recurring: true },
      description: `Monthly Subscription for user_id: ${user.id}`,
      confirmation: { type: 'embedded', locale: 'en_US' },
      save_payment_method: true,
    });
  });

  it('purchase with an invalid product id returns 400, with nothing written', async () => {
    const user = await newUser();
    const res = await purchase({ product_id: 'INVALID_PRODUCT_12345', currency: 'RUB', provider_id: 'YOOKASSA' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Product INVALID_PRODUCT_12345 not found or not available' });
    expect(await reposOf(t).payments.getByUserId(user.id)).toEqual([]);
  });

  it('a legacy plan cannot be bought again', async () => {
    await newUser();
    const res = await purchase({ product_id: 'MONTH_SUB_V2', currency: 'RUB', provider_id: 'YOOKASSA' });

    expect(res.status).toBe(400);
  });

  it('a missing product id is a 422', async () => {
    await newUser();
    const res = await t.client.post('/payments/start_purchase', { currency: 'RUB' }, { headers });

    expect(res.status).toBe(422);
  });

  it('defaults to RUB through YooKassa', async () => {
    const user = await newUser();
    const res = await t.client.post('/payments/start_purchase', { product_id: MONTHLY_PRODUCT_ID }, { headers });

    expect(res.status).toBe(200);
    const [row] = await reposOf(t).payments.getByUserId(user.id);
    expect(row).toMatchObject({ currency: 'RUB', providerId: 'YOOKASSA' });
  });

  it('a provider failure rolls the payment back and answers 500', async () => {
    const user = await newUser();
    yookassa.networkError = new Error('connection reset');

    const res = await purchase({ product_id: MONTHLY_PRODUCT_ID, currency: 'RUB' });

    yookassa.networkError = null;
    expect(res.status).toBe(500);
    expect(await reposOf(t).payments.getByUserId(user.id)).toEqual([]);
  });

  it('a provider without an implementation answers 500, with nothing written', async () => {
    const user = await newUser();
    const res = await purchase({ product_id: MONTHLY_PRODUCT_ID, currency: 'RUB', provider_id: 'GIFT' });

    expect(res.status).toBe(500);
    expect(await reposOf(t).payments.getByUserId(user.id)).toEqual([]);
  });
});

describe('Telegram Stars payment', () => {
  it('creates an invoice for a one-time product', async () => {
    const user = await newUser();
    const res = await purchase({ product_id: 'TEST_ONETIME', currency: 'XTR', provider_id: 'TELEGRAM_STARS' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { confirmation_url: string; payment_id: string; amount: number };
    expect(data.confirmation_url).toBe('https://t.me/$invoice');
    expect(data.amount).toBe(1);
    expect(Object.keys(data)).toEqual(['payment_id', 'confirmation_token', 'confirmation_url', 'amount', 'currency']);

    const [call] = t.fakes.bot.sent('createInvoiceLink');
    expect(call?.payload).toMatchObject({
      title: 'Test One-time Payment',
      description: 'Purchase of Test One-time Payment',
      payload: `payment_${data.payment_id}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Test One-time Payment', amount: 1 }],
    });
    expect(call?.payload).not.toHaveProperty('subscription_period');
    const [row] = await reposOf(t).payments.getByUserId(user.id);
    expect(row).toMatchObject({
      status: 'WAITING_FOR_ACTION',
      providerPaymentId: `tg_stars_${data.payment_id}`,
      providerMetadata: { invoice_link: 'https://t.me/$invoice', stars_amount: 1 },
    });
  });

  it('a 30-day subscription product is a native Star subscription', async () => {
    await newUser();
    const res = await purchase({ product_id: 'TEST_SUBSCRIPTION', currency: 'XTR', provider_id: 'TELEGRAM_STARS' });

    expect(res.status).toBe(200);
    const [call] = t.fakes.bot.sent('createInvoiceLink');
    expect(call?.payload).toMatchObject({
      subscription_period: 2592000,
      description: 'Purchase of Test Subscription - Auto-renewing every 30 days',
    });
  });

  it('a Telegram failure leaves a FAILED payment and still answers 200, with no invoice', async () => {
    const user = await newUser();
    t.fakes.bot.failNext('createInvoiceLink', { error_code: 400, description: 'Bad Request: nope' });

    const res = await purchase({ product_id: 'TEST_ONETIME', currency: 'XTR', provider_id: 'TELEGRAM_STARS' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ confirmation_url: '', amount: 1, currency: 'XTR' });
    const [row] = await reposOf(t).payments.getByUserId(user.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.providerMetadata.error).toContain('Bad Request: nope');
  });

  it.each(['USD', 'RUB'])('a %s price is a 400, with no payment and no invoice', async (currency) => {
    // The invoice charges the amount in Stars: $3.99 would have been 3 Stars for a month
    const user = await newUser();

    const res = await purchase({ product_id: 'MONTH_SUB_V3', currency, provider_id: 'TELEGRAM_STARS' });

    expect(res.status).toBe(400);
    expect((await res.json()) as { detail: string }).toEqual({
      detail: `Telegram Stars payments are in XTR, not ${currency}`,
    });
    expect(await reposOf(t).payments.getByUserId(user.id)).toEqual([]);
    expect(t.fakes.bot.sent('createInvoiceLink')).toEqual([]);
  });
});

describe('daily purchase limit', () => {
  const pack = (productId: string, limit: number | null) =>
    Object.assign(
      new Product({ productId, name: productId, durationDays: 1, prices: { XTR: { amount: 5, currency: 'XTR' } } }),
      { dailyPurchaseLimit: limit },
    );
  const catalog = {
    ...products,
    AVAILABLE_PRODUCTS: { PACK_A: pack('PACK_A', 2), PACK_B: pack('PACK_B', 2), FREE: pack('FREE', null) },
    getProduct(id: string) {
      return this.AVAILABLE_PRODUCTS[id as 'PACK_A'] ?? null;
    },
  };

  const startWith = (userId: string, productId: string) =>
    inTransaction(t, (services) => {
      const payments = new (
        services.payments.constructor as typeof services.payments.constructor & {
          new (...args: unknown[]): typeof services.payments;
        }
      )(services.repos, services.producer, services, services.bot, catalog);
      return payments.startPayment(userId, productId, 'XTR', 'TELEGRAM_STARS');
    });

  it('limited products share one cap per user in 24 h', async () => {
    const user = await newUser();
    const paid = { userId: user.id, providerId: 'TELEGRAM_STARS', currency: 'XTR', amount: 5 } as const;
    await reposOf(t).payments.create({ ...paid, productId: 'PACK_A', status: 'SUCCEEDED' });
    await reposOf(t).payments.create({ ...paid, productId: 'PACK_B', status: 'SUCCEEDED' });
    await reposOf(t).payments.create({ ...paid, productId: 'PACK_B', status: 'FAILED' });

    await expect(startWith(user.id, 'PACK_A')).rejects.toThrow('Daily purchase limit reached (2 in 24 h)');
    await expect(startWith(user.id, 'FREE')).resolves.toBeDefined();
    expect(events(t, 'purchase_daily_limit_reached')[0]?.properties).toMatchObject({ limit: 2, product_id: 'PACK_A' });
  });
});

describe('authorization', () => {
  it('a guest payment is handled gracefully', async () => {
    const res = await t.client.post('/payments/start_purchase', {
      product_id: 'TEST_ONETIME',
      currency: 'XTR',
      provider_id: 'TELEGRAM_STARS',
      return_url: RETURN_URL,
    });

    expect([200, 400, 401, 403]).toContain(res.status);
  });

  it("a logged-out visitor can't buy: it is a 401, with nothing written for the shared guest row", async () => {
    const res = await t.client.post('/payments/start_purchase', {
      product_id: MONTHLY_PRODUCT_ID,
      currency: 'RUB',
      provider_id: 'YOOKASSA',
      return_url: RETURN_URL,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: { error: 'not_authenticated', message: 'Login required' } });
    expect(await reposOf(t).payments.getByUserId(MOCK_GUEST_USER_ID)).toEqual([]);
  });

  it("a logged-out visitor can't read the shared guest's payments either", async () => {
    await t.client.get('/payments/products'); // creates the guest row
    const payment = await makePayment(t, MOCK_GUEST_USER_ID, { status: PaymentStatus.SUCCEEDED });

    const res = await t.client.get(`/payments/${payment.id}/status`);

    expect(res.status).toBe(401);
  });
});

describe('complete flow', () => {
  it('a user can view products, then buy the first one', async () => {
    await newUser();
    const list = (await (await t.client.get('/payments/products', { headers })).json()) as ProductJson[];
    const product = list[0];

    const res = await purchase({ product_id: product?.id, currency: product?.currency, provider_id: 'YOOKASSA' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { confirmation_token: string }).confirmation_token).toBeTruthy();
  });
});

describe('parseUuid', () => {
  it('reads the forms Python does', () => {
    const canonical = '12345678-1234-5678-1234-567812345678';
    expect(parseUuid(canonical)).toBe(canonical);
    expect(parseUuid('12345678123456781234567812345678')).toBe(canonical);
    expect(parseUuid(`{${canonical}}`)).toBe(canonical);
    expect(parseUuid(`urn:uuid:${canonical}`)).toBe(canonical);
    expect(parseUuid(canonical.toUpperCase())).toBe(canonical);
    expect(parseUuid('not-a-uuid')).toBeNull();
  });
});

describe('composition', () => {
  it('services use the injected catalog', async () => {
    await inTransaction(t, async (services) => {
      expect(services.payments.products).toBe(services.products);
      expect(services.subscriptions.products).toBe(services.products);
      expect(services.products).toBe(products);
    });
  });

  it('caches its services', async () => {
    await inTransaction(t, async (services) => {
      expect(services.payments).toBe(services.payments);
    });
  });
});

describe('product catalog', () => {
  const all = { ...AVAILABLE_PRODUCTS, ...LEGACY_PRODUCTS, ...TEST_PRODUCTS };

  it('exposes the three lists', () => {
    expect(Object.keys(AVAILABLE_PRODUCTS).length).toBeGreaterThan(0);
    expect(typeof LEGACY_PRODUCTS).toBe('object');
    expect(typeof TEST_PRODUCTS).toBe('object');
  });

  it('a product id matches its key; durations and prices are positive', () => {
    for (const [key, product] of Object.entries(all)) {
      expect(product.productId).toBe(key);
      expect(product.durationDays).toBeGreaterThan(0);
      const prices = Object.values(product.prices ?? {});
      expect(prices.length).toBeGreaterThan(0);
      for (const price of prices) expect(price.amount).toBeGreaterThan(0);
    }
  });

  it('getPriceFor falls back to the first price', () => {
    const product = Object.values(AVAILABLE_PRODUCTS)[0];
    expect(product?.getPriceFor('RUB').amount).toBeGreaterThan(0);
    expect(product?.getPriceFor('NON_EXISTENT_CURRENCY')).toEqual(product?.getPriceFor('RUB'));
  });

  it('every product has a reward', () => {
    for (const product of Object.values(AVAILABLE_PRODUCTS)) {
      expect(product.reward).toBeTypeOf('function');
      expect((product as Product).rewardHandler).toBeTypeOf('function');
    }
  });

  it('getProduct finds active and legacy products, and not unknown ones', () => {
    for (const id of Object.keys(AVAILABLE_PRODUCTS)) expect(getProduct(id)).not.toBeNull();
    for (const id of Object.keys(LEGACY_PRODUCTS)) expect(getProduct(id)).not.toBeNull();
    expect(getProduct('UNKNOWN_PRODUCT_ID_12345')).toBeNull();
    expect(getProduct('constructor')).toBeNull();
  });

  it('test products exist only in debug mode', () => {
    expect(getProduct('TEST_ONETIME')).not.toBeNull();
    const debug = settings.debug;
    settings.debug = false;
    const released = getProduct('TEST_ONETIME');
    settings.debug = debug;
    expect(released).toBeNull();
  });

  it('subscription products recur, with standard durations', () => {
    for (const [id, product] of Object.entries(AVAILABLE_PRODUCTS)) {
      if (id.includes('SUB')) {
        expect(product.recurring).toBe(true);
        expect([7, 30, 365]).toContain(product.durationDays);
      }
    }
  });

  it('productPriceIn never falls back to another currency', () => {
    const product = getProduct('MONTH_SUB_V3');
    expect(productPriceIn(product, 'USD')?.amount).toBe(3.99);
    expect(productPriceIn(product, 'EUR')).toBeNull();
    expect(productPriceIn(null, 'USD')).toBeNull();
    const single = { ...product, prices: undefined, getPriceFor: () => ({ amount: 5, currency: 'RUB' }) } as never;
    expect(productPriceIn(single, 'RUB')?.amount).toBe(5);
    expect(productPriceIn(single, 'USD')).toBeNull();
  });
});
