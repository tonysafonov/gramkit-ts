import { and, count, desc, eq, gte, inArray, lte, sum } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type Payment, type PaymentEvent, PaymentStatus, paymentEvents, payments } from '../../db/schema';

const succeededBetween = (from: Date, to: Date = new Date()) =>
  and(eq(payments.status, PaymentStatus.SUCCEEDED), gte(payments.createdAt, from), lte(payments.createdAt, to));

export class PaymentsRepo extends BaseRepo<typeof payments> {
  constructor(db: Db) {
    super(db, payments, payments.id);
  }

  async getByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    const rows = await this.db.select().from(payments).where(eq(payments.providerPaymentId, providerPaymentId));
    if (rows.length > 1) throw new Error(`Multiple payments with provider id ${providerPaymentId}`);
    return rows[0] ?? null;
  }

  /** Succeeded payments of these products by this user created since `since`. */
  async countSucceededSince(userId: string, productIds: string[], since: Date): Promise<number> {
    if (productIds.length === 0) return 0;
    const [row] = await this.db
      .select({ total: count() })
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          inArray(payments.productId, productIds),
          eq(payments.status, PaymentStatus.SUCCEEDED),
          gte(payments.createdAt, since),
        ),
      );
    return row?.total ?? 0;
  }

  getByUserId(userId: string): Promise<Payment[]> {
    return this.db.select().from(payments).where(eq(payments.userId, userId));
  }

  /**
   * A SUCCEEDED renewal already exists for this billing period: do not re-charge.
   *
   * Only SUCCEEDED blocks the renewal: a prior FAILED attempt must stay retryable so the dunning budget can advance.
   * The key is deterministic per (subscription, end date), so it identifies the period.
   */
  async getSucceededRenewalForPeriod(idempotencyKey: string): Promise<Payment | null> {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.idempotencyKey, idempotencyKey), eq(payments.status, PaymentStatus.SUCCEEDED)))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Latest non-terminal (CREATED/WAITING_FOR_ACTION) renewal payment for this period key.
   *
   * Recovers a renewal stranded mid-flow (the process died between the provider call and the result write): its row
   * keeps the period key, so `uq_payment_idempotency_key` would block any fresh attempt. The deterministic key makes
   * the recovery re-charge idempotent on YooKassa's side within its idempotency window.
   */
  async getNonterminalRenewalForPeriod(idempotencyKey: string): Promise<Payment | null> {
    const rows = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.idempotencyKey, idempotencyKey),
          inArray(payments.status, [PaymentStatus.CREATED, PaymentStatus.WAITING_FOR_ACTION]),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  // Statistics

  /** Total revenue per currency, successful payments only. */
  async getTotalRevenueByCurrency(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ currency: payments.currency, total: sum(payments.amount).mapWith(Number) })
      .from(payments)
      .where(eq(payments.status, PaymentStatus.SUCCEEDED))
      .groupBy(payments.currency);
    return Object.fromEntries(rows.map((row) => [row.currency, row.total]));
  }

  /** Total revenue in one currency between dates. */
  async getRevenueByCurrencyAndDate(currency: string, from: Date, to?: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(payments.amount).mapWith(Number) })
      .from(payments)
      .where(and(succeededBetween(from, to), eq(payments.currency, currency)));
    return row?.total ?? 0;
  }

  /** Revenue per currency between dates. */
  async getRevenueByAllCurrenciesAndDate(from: Date, to?: Date): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ currency: payments.currency, total: sum(payments.amount).mapWith(Number) })
      .from(payments)
      .where(succeededBetween(from, to))
      .groupBy(payments.currency);
    return Object.fromEntries(rows.map((row) => [row.currency, row.total]));
  }

  /** Successful payments per product. */
  async getProductSalesStats(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ productId: payments.productId, total: count() })
      .from(payments)
      .where(eq(payments.status, PaymentStatus.SUCCEEDED))
      .groupBy(payments.productId);
    return Object.fromEntries(rows.map((row) => [row.productId, row.total]));
  }

  /** Successful payments per product between dates. */
  async getProductSalesStatsByDate(from: Date, to?: Date): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ productId: payments.productId, total: count() })
      .from(payments)
      .where(succeededBetween(from, to))
      .groupBy(payments.productId);
    return Object.fromEntries(rows.map((row) => [row.productId, row.total]));
  }

  /** Successful payments between dates, split into first purchases and recurring renewals. */
  async getSucceededCountsByKind(from: Date, to?: Date): Promise<{ first: number; recurring: number }> {
    const rows = await this.db
      .select({ isRecurring: payments.isRecurring, total: count() })
      .from(payments)
      .where(succeededBetween(from, to))
      .groupBy(payments.isRecurring);
    const totalOf = (isRecurring: boolean) => rows.find((row) => row.isRecurring === isRecurring)?.total ?? 0;
    return { first: totalOf(false), recurring: totalOf(true) };
  }
}

export class PaymentEventsRepo extends BaseRepo<typeof paymentEvents> {
  constructor(db: Db) {
    super(db, paymentEvents, paymentEvents.id);
  }

  getByPaymentId(paymentId: string): Promise<PaymentEvent[]> {
    return this.db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId));
  }
}
