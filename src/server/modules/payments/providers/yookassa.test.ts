/** The YooKassa client and request builder: what the Python app got from the SDK. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../../config';
import { Product, type ProductCatalog, products } from '../products';
import { PaymentValueError } from '../types';
import { buildPaymentRequest } from './yookassa';
import { parseWebhookNotification, YooKassaApiError, yookassaPayments, yookassaRefunds } from './yookassa-api';

const payment = { id: 'p1', productId: 'MONTH_SUB_V3', userId: 'u1', currency: 'RUB' };

const catalogWith = (amount: number, name = 'Pack'): ProductCatalog => ({
  ...products,
  getProduct: () =>
    new Product({ productId: 'X', name, durationDays: 7, prices: { RUB: { amount, currency: 'RUB' } } }),
});

function stubFetch(...responses: Response[]) {
  const fetchStub = vi.fn(async () => responses.shift() ?? new Response('{}'));
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

afterEach(() => vi.unstubAllGlobals());

describe('buildPaymentRequest', () => {
  it('rounds the amount half up to two places, as the SDK does', () => {
    const body = buildPaymentRequest(catalogWith(1.005), payment);

    expect(body.amount).toEqual({ value: '1.01', currency: 'RUB' });
  });

  it('prices a currency the product lacks with its first price; the receipt keeps the asked currency', () => {
    const body = buildPaymentRequest(products, { ...payment, currency: 'EUR' });

    expect(body.amount).toEqual({ value: '555.00', currency: 'RUB' });
    expect(body.receipt).toMatchObject({ items: [{ amount: { value: '555.00', currency: 'EUR' } }] });
  });

  it('a non-recurring product saves no card', () => {
    expect(buildPaymentRequest(catalogWith(10), payment)).not.toHaveProperty('save_payment_method');
  });

  it('a locale the widget has no version of is left to auto-detect', () => {
    expect(buildPaymentRequest(products, payment, { locale: 'de' }).confirmation).toEqual({ type: 'embedded' });
    expect(buildPaymentRequest(products, payment, { locale: 'RU' }).confirmation).toEqual({
      type: 'embedded',
      locale: 'ru_RU',
    });
  });

  it('throws what the SDK validation raises', () => {
    expect(() => buildPaymentRequest(catalogWith(0), payment)).toThrow(PaymentValueError);
    expect(() => buildPaymentRequest(catalogWith(5, 'x'.repeat(200)), payment)).toThrow(/too long/);
    expect(() => buildPaymentRequest({ ...products, getProduct: () => null }, payment)).toThrow(
      'Product MONTH_SUB_V3 not found',
    );

    const { receiptEmail } = settings.payment;
    settings.payment.receiptEmail = '';
    expect(() => buildPaymentRequest(products, payment)).toThrow('Invalid email value type');
    settings.payment.receiptEmail = receiptEmail;
  });
});

describe('the API client', () => {
  it('authenticates with the shop id and secret key', async () => {
    const fetchStub = stubFetch(Response.json({ id: 'x', status: 'pending' }));

    await yookassaPayments.findOne('x');

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.yookassa.ru/v3/payments/x');
    const expected = Buffer.from(`${settings.payment.shopId}:${settings.payment.secretKey}`).toString('base64');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${expected}`);
  });

  it('asks again on a 202, with the same key', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 202 }), Response.json({ id: 'x', status: 'succeeded' }));

    const payment = await yookassaPayments.create({}, 'key-1');

    expect(payment.status).toBe('succeeded');
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const inits = fetchStub.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1]);
    expect(inits.map((init) => (init.headers as Record<string, string>)['idempotence-key'])).toEqual([
      'key-1',
      'key-1',
    ]);
  });

  it('a create with no key gets a random one', async () => {
    const fetchStub = stubFetch(Response.json({ id: 'x', status: 'pending' }));

    await yookassaPayments.create({});

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['idempotence-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('anything but a 200 throws, a GET 202 included', async () => {
    stubFetch(Response.json({ code: 'not_found' }, { status: 404 }));
    await expect(yookassaPayments.findOne('x')).rejects.toThrow(YooKassaApiError);

    stubFetch(new Response('oops', { status: 500 }));
    await expect(yookassaRefunds.findOne('x')).rejects.toMatchObject({ status: 500, body: 'oops' });

    const fetchStub = stubFetch(new Response('{}', { status: 202 }));
    await expect(yookassaPayments.findOne('x')).rejects.toThrow(YooKassaApiError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('an empty id never reaches the API', async () => {
    const fetchStub = stubFetch();

    await expect(yookassaPayments.findOne('')).rejects.toThrow('Invalid payment_id value');
    await expect(yookassaPayments.findOne(undefined)).rejects.toThrow('Invalid payment_id value');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('an id cannot escape its path', async () => {
    const fetchStub = stubFetch(Response.json({ id: 'x', status: 'pending' }));

    await yookassaPayments.findOne('../refunds/1');

    expect(fetchStub.mock.calls[0]).toContain('https://api.yookassa.ru/v3/payments/..%2Frefunds%2F1');
  });

  it('with no credentials nothing goes out', async () => {
    const fetchStub = stubFetch();
    const { shopId } = settings.payment;
    settings.payment.shopId = '';

    await expect(yookassaPayments.findOne('x')).rejects.toThrow('credentials');

    settings.payment.shopId = shopId;
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('parseWebhookNotification', () => {
  it('reads a notification', () => {
    const object = { id: 'x' };

    expect(parseWebhookNotification({ type: 'notification', event: 'payment.succeeded', object })).toEqual({
      event: 'payment.succeeded',
      object,
    });
  });

  it.each([
    ['a list', []],
    ['no event', { type: 'notification' }],
    ['another type', { type: 'other', event: 'e' }],
    ['a null object', { type: 'notification', event: 'e', object: null }],
    ['an empty object', { type: 'notification', event: 'e', object: {} }],
    ['a string object', { type: 'notification', event: 'e', object: 'x' }],
  ])('throws on %s', (_name, data) => {
    expect(() => parseWebhookNotification(data)).toThrow();
  });
});
