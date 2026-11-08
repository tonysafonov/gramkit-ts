/** Idempotency keys and the partial unique index behind them: port of Python gramkit's `test_idempotency.py`. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../db/schema';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { renewalIdempotencyKey } from './providers/yookassa';
import { makePayment, reposOf } from './test-helpers';
import { addDays, isoformat, isoformatFromPg } from './utils';

const END = new Date(Date.UTC(2026, 5, 18, 12, 0));

describe('renewalIdempotencyKey', () => {
  it('is deterministic', () => {
    const id = randomUUID();
    expect(renewalIdempotencyKey(id, END)).toBe(renewalIdempotencyKey(id, END));
  });

  it('changes when the period rolls over', () => {
    const id = randomUUID();
    expect(renewalIdempotencyKey(id, END)).not.toBe(renewalIdempotencyKey(id, addDays(END, 30)));
  });

  it('differs per subscription', () => {
    expect(renewalIdempotencyKey(randomUUID(), END)).not.toBe(renewalIdempotencyKey(randomUUID(), END));
  });

  it('fits the column', () => {
    expect(renewalIdempotencyKey(randomUUID(), END)).toHaveLength(32);
  });

  it('is the key Python computes for the same period', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(renewalIdempotencyKey(id, END)).toBe('77dd96062fa38bbe2a64ed62c4cb0c2d');
    expect(renewalIdempotencyKey(id, new Date(Date.UTC(2026, 5, 18, 12, 0, 0, 250)))).toBe(
      'f4c1f7241a1e11b0582362ada260eeee',
    );
  });
});

describe('isoformat', () => {
  it('writes what Python writes', () => {
    expect(isoformat(END)).toBe('2026-06-18T12:00:00+00:00');
    expect(isoformat(new Date(Date.UTC(2026, 5, 18, 12, 0, 0, 250)))).toBe('2026-06-18T12:00:00.250000+00:00');
  });
});

describe('isoformatFromPg', () => {
  it("keeps Postgres' microseconds, as Python's isoformat does", () => {
    expect(isoformatFromPg('2026-06-18T12:00:00.123456')).toBe('2026-06-18T12:00:00.123456+00:00');
    expect(isoformatFromPg('2026-06-18T12:00:00.250000')).toBe('2026-06-18T12:00:00.250000+00:00');
    expect(isoformatFromPg('2026-06-18T12:00:00.000000')).toBe('2026-06-18T12:00:00+00:00');
  });

  it('is the key Python computes for an end_date with microseconds, which a Date would lose', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const exact = { isoformat: isoformatFromPg('2026-06-18T12:00:00.123456') };
    // hashlib.sha256(f"renewal:{id}:{datetime(2026, 6, 18, 12, 0, 0, 123456, tzinfo=UTC).isoformat()}")[:32]
    expect(renewalIdempotencyKey(id, exact)).toBe('aa36c6bc04659d8bb8bc69faa76bc923');
    expect(renewalIdempotencyKey(id, { isoformat: isoformatFromPg('2026-06-18T12:00:00.000000') })).toBe(
      '77dd96062fa38bbe2a64ed62c4cb0c2d',
    );
  });
});

describe('uq_payment_idempotency_key', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('rejects a duplicate non-terminal key', async () => {
    const user = await createUser(t.db);
    await makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: 'a'.repeat(32) });

    await expect(
      makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: 'a'.repeat(32) }),
    ).rejects.toThrow();
  });

  it('a terminal-FAILED attempt does not block the retry', async () => {
    const user = await createUser(t.db);
    await makePayment(t, user.id, { status: PaymentStatus.FAILED, idempotencyKey: 'b'.repeat(32) });

    const retry = await makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: 'b'.repeat(32) });

    expect(retry.id).toBeTruthy();
  });

  it('allows null keys', async () => {
    const user = await createUser(t.db);
    const first = await makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: null });
    const second = await makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: null });

    expect(first.id).not.toBe(second.id);
  });

  it('the dedup query matches SUCCEEDED only', async () => {
    const user = await createUser(t.db);
    const key = 'c'.repeat(32);

    await makePayment(t, user.id, { status: PaymentStatus.FAILED, idempotencyKey: key });
    expect(await reposOf(t).payments.getSucceededRenewalForPeriod(key)).toBeNull();

    const succeeded = await makePayment(t, user.id, { status: PaymentStatus.SUCCEEDED, idempotencyKey: key });
    expect((await reposOf(t).payments.getSucceededRenewalForPeriod(key))?.id).toBe(succeeded.id);
  });

  it('the stranded query matches non-terminal rows only', async () => {
    const user = await createUser(t.db);
    const key = 'd'.repeat(32);

    await makePayment(t, user.id, { status: PaymentStatus.FAILED, idempotencyKey: key });
    expect(await reposOf(t).payments.getNonterminalRenewalForPeriod(key)).toBeNull();

    const created = await makePayment(t, user.id, { status: PaymentStatus.CREATED, idempotencyKey: key });
    expect((await reposOf(t).payments.getNonterminalRenewalForPeriod(key))?.id).toBe(created.id);
  });
});

describe('statistics queries', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('count succeeded payments only, per currency, product and kind', async () => {
    const user = await createUser(t.db);
    await makePayment(t, user.id, { isRecurring: false, amount: 100, productId: 'WEEK_SUB' });
    await makePayment(t, user.id, { isRecurring: true, amount: 50, productId: 'WEEK_SUB_V2' });
    await makePayment(t, user.id, { isRecurring: true, amount: 5, currency: 'XTR', productId: 'WEEK_SUB_V2' });
    await makePayment(t, user.id, { status: PaymentStatus.CANCELED, amount: 999 });
    const repo = reposOf(t).payments;
    const from = addDays(new Date(), -1);
    const to = addDays(new Date(), 1);

    expect(await repo.getTotalRevenueByCurrency()).toEqual({ RUB: 150, XTR: 5 });
    expect(await repo.getRevenueByAllCurrenciesAndDate(from, to)).toEqual({ RUB: 150, XTR: 5 });
    expect(await repo.getRevenueByCurrencyAndDate('RUB', from, to)).toBe(150);
    expect(await repo.getRevenueByCurrencyAndDate('EUR', from, to)).toBe(0);
    expect(await repo.getProductSalesStats()).toEqual({ WEEK_SUB: 1, WEEK_SUB_V2: 2 });
    expect(await repo.getProductSalesStatsByDate(from, to)).toEqual({ WEEK_SUB: 1, WEEK_SUB_V2: 2 });
    expect(await repo.getSucceededCountsByKind(from, to)).toEqual({ first: 1, recurring: 2 });
    expect(await repo.getRevenueByAllCurrenciesAndDate(addDays(new Date(), 1), addDays(new Date(), 2))).toEqual({});
  });
});
