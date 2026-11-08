/** GET /payments/{id}/status: port of Python gramkit's `test_payment_status.py`. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentStatus, type User } from '../../db/schema';
import { asUser, createTestApp, createUser, FakeYooKassa, type TestApp } from '../../testing';
import { events, makePayment, reposOf, resetFakes } from './test-helpers';

let t: TestApp;
let user: User;
let headers: Record<string, string>;
let yookassa: FakeYooKassa;

const status = (id: string) => t.client.get(`/payments/${id}/status`, { headers });

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

beforeEach(async () => {
  yookassa = new FakeYooKassa().install();
  user = await createUser(t.db);
  headers = asUser(user);
});

afterEach(() => {
  yookassa.uninstall();
  resetFakes(t);
});

describe('GET /payments/{id}/status', () => {
  it('returns the stored status for an owned non-final payment with no provider id', async () => {
    const payment = await makePayment(t, user.id, { status: PaymentStatus.WAITING_FOR_ACTION });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payment_id: payment.id, status: 'WAITING_FOR_ACTION' });
    expect(yookassa.requests).toEqual([]);
  });

  it('a final payment returns its status without asking the provider', async () => {
    const payment = await makePayment(t, user.id, { providerPaymentId: 'pay_final_123' });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('SUCCEEDED');
    expect(yookassa.requests).toEqual([]);
  });

  it('a payment owned by another user is a 404', async () => {
    const other = await createUser(t.db);
    const payment = await makePayment(t, other.id, { status: PaymentStatus.WAITING_FOR_ACTION });

    const res = await status(payment.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Payment not found' });
  });

  it('an unknown well-formed id is a 404', async () => {
    expect((await status(randomUUID())).status).toBe(404);
  });

  it('a malformed id is a 404, not a 422', async () => {
    expect((await status('not-a-uuid')).status).toBe(404);
  });

  it('reconciles live and persists the new status', async () => {
    // Non-catalog product: a pure status-mapping test, the reward no-ops.
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      productId: 'TEST_PRODUCT',
      providerPaymentId: 'pay_live_123',
    });
    yookassa.addPayment({ id: 'pay_live_123', status: 'succeeded' });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('SUCCEEDED');
    expect((await reposOf(t).payments.getById(payment.id))?.status).toBe('SUCCEEDED');
  });

  it.each([
    ['succeeded', 'SUCCEEDED'],
    ['canceled', 'CANCELED'],
    ['waiting_for_capture', 'WAITING_FOR_ACTION'],
    ['pending', 'WAITING_FOR_ACTION'],
    ['something_new', 'WAITING_FOR_ACTION'],
  ])('maps the provider status %s to %s', async (remote, expected) => {
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      productId: 'TEST_PRODUCT',
      providerPaymentId: `pay_${remote}`,
    });
    yookassa.addPayment({ id: `pay_${remote}`, status: remote });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe(expected);
  });

  it('a provider failure answers the stored status', async () => {
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      providerPaymentId: 'pay_unknown_to_provider',
    });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('WAITING_FOR_ACTION');
  });

  it('a canceled reconcile reports why', async () => {
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      providerPaymentId: 'pay_declined',
    });
    yookassa.addPayment({
      id: 'pay_declined',
      status: 'canceled',
      payment_method: { id: 'pm', type: 'sbp' },
      cancellation_details: { party: 'payment_network', reason: 'insufficient_funds' },
    });

    await status(payment.id);

    const [failed] = events(t, 'payment_failed');
    expect(failed?.properties).toMatchObject({
      status: 'CANCELED',
      reason: 'insufficient_funds',
      party: 'payment_network',
      payment_method_type: 'sbp',
    });
  });

  it('REGRESSION: a SUCCEEDED reconcile grants entitlement, not just the status', async () => {
    // The 1.5 s frontend poll usually beats the webhook: if the reconcile only marked the payment SUCCEEDED, the later
    // webhook's finality guard would skip the reward, and the user would pay and get nothing.
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      productId: 'MONTH_SUB_V3',
      providerPaymentId: 'pay_grant_123',
    });
    yookassa.addPayment({ id: 'pay_grant_123', status: 'succeeded', payment_method: { id: 'pm_test_123' } });

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('SUCCEEDED');
    const refetched = await reposOf(t).payments.getById(payment.id);
    expect(refetched?.status).toBe('SUCCEEDED');
    expect(refetched?.wasRewarded).toBe(true);
    const subscription = await reposOf(t).subscriptions.getActiveByUserId(user.id);
    expect(subscription?.productId).toBe('MONTH_SUB_V3');
    expect(subscription?.recurringDetails.payment_method_id).toBe('pm_test_123');
    expect(subscription?.paymentMethodId).toBe('pm_test_123');
    const log = await reposOf(t).paymentEvents.getByPaymentId(payment.id);
    expect(log.map((e) => e.rawData)).toEqual([{ source: 'status_reconcile', remote_status: 'SUCCEEDED' }]);
  });

  it('REGRESSION: a second reconcile neither rewards nor asks the provider again', async () => {
    const payment = await makePayment(t, user.id, {
      status: PaymentStatus.WAITING_FOR_ACTION,
      productId: 'MONTH_SUB_V3',
      providerPaymentId: 'pay_once_123',
    });
    yookassa.addPayment({ id: 'pay_once_123', status: 'succeeded', payment_method: { id: 'pm_once_123' } });

    await status(payment.id);
    const first = await reposOf(t).subscriptions.getByUserId(user.id);
    const asked = yookassa.requests.length;

    const res = await status(payment.id);

    expect(res.status).toBe(200);
    expect(yookassa.requests.length).toBe(asked);
    const second = await reposOf(t).subscriptions.getByUserId(user.id);
    expect(second).toHaveLength(1);
    expect(second[0]?.endDate).toEqual(first[0]?.endDate);
  });
});
