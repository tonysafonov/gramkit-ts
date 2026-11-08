import {
  and,
  count,
  countDistinct,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { PaymentProvider, PaymentStatus, payments, SubscriptionStatus, subscriptions } from '../../db/schema';

/** Providers whose payments are not real money: Telegram Stars (XTR) and admin gifts. Everything else is cash. */
export const NON_CASH_PROVIDERS: PaymentProvider[] = [PaymentProvider.TELEGRAM_STARS, PaymentProvider.GIFT];

/** Statuses that still grant access: ACTIVE, PAST_DUE (in dunning grace), CANCELED (until the end date). */
const ENTITLED_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.CANCELED,
];
const CHURNED_STATUSES: SubscriptionStatus[] = [SubscriptionStatus.CANCELED, SubscriptionStatus.EXPIRED];

export interface RevenueBucketRow {
  bucket: Date;
  currency: string;
  providerId: string;
  amount: number;
  count: number;
}

export interface KpiRow {
  currency: string;
  payingUsers: number;
  revenue: number;
  paymentCount: number;
}

export interface ActivePaidRow {
  productId: string;
  currency: string;
  count: number;
}

const sumOf = (column: SQLWrapper) => sql<number>`coalesce(sum(${column}), 0.0)`.mapWith(Number);

/**
 * Read-only aggregations for the admin money analytics (`/admin/analytics/*`). Every method is a pure SELECT.
 * Buckets are computed in Postgres with `date_trunc`. Money is grouped by `(currency, provider_id)` and never summed
 * across currencies. Cash is every provider except `NON_CASH_PROVIDERS`, so a new real-money provider counts as cash.
 */
export class AnalyticsRepo extends BaseRepo<typeof payments> {
  constructor(db: Db) {
    super(db, payments, payments.id);
  }

  /** Bucketed revenue grouped by (bucket, currency, provider). Only SUCCEEDED payments count. */
  async revenueTimeseries({
    since,
    granularity,
  }: {
    since: Date;
    granularity: 'day' | 'week';
  }): Promise<RevenueBucketRow[]> {
    const unit = sql.raw(granularity === 'week' ? "'week'" : "'day'");
    const bucket = sql<Date>`date_trunc(${unit}, ${payments.createdAt})`.mapWith(payments.createdAt).as('bucket');
    return this.db
      .select({
        bucket,
        currency: payments.currency,
        providerId: payments.providerId,
        amount: sumOf(payments.amount).as('amount'),
        count: count().as('count'),
      })
      .from(payments)
      .where(and(eq(payments.status, PaymentStatus.SUCCEEDED), gte(payments.createdAt, since)))
      .groupBy(bucket, payments.currency, payments.providerId)
      .orderBy(bucket);
  }

  /**
   * Per-currency CASH KPIs over all-time SUCCEEDED payments: distinct paying users, revenue, payment count.
   * Non-cash providers are excluded.
   */
  async revenueKpisByCurrency(): Promise<KpiRow[]> {
    return this.db
      .select({
        currency: payments.currency,
        payingUsers: countDistinct(payments.userId),
        revenue: sumOf(payments.amount),
        paymentCount: count(),
      })
      .from(payments)
      .where(and(eq(payments.status, PaymentStatus.SUCCEEDED), notInArray(payments.providerId, NON_CASH_PROVIDERS)))
      .groupBy(payments.currency);
  }

  /** Total SUCCEEDED CASH revenue per currency in `[since, until)`. */
  async cashRevenueInRangeByCurrency({ since, until }: { since: Date; until: Date }): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ currency: payments.currency, amount: sumOf(payments.amount) })
      .from(payments)
      .where(
        and(
          eq(payments.status, PaymentStatus.SUCCEEDED),
          notInArray(payments.providerId, NON_CASH_PROVIDERS),
          gte(payments.createdAt, since),
          lt(payments.createdAt, until),
        ),
      )
      .groupBy(payments.currency);
    return new Map(rows.map((row) => [row.currency, row.amount]));
  }

  async subscriptionsStartedByWeek({ since }: { since: Date }): Promise<Map<Date, number>> {
    const bucket = sql<Date>`date_trunc('week', ${subscriptions.startDate})`
      .mapWith(subscriptions.startDate)
      .as('bucket');
    const rows = await this.db
      .select({ bucket, count: count() })
      .from(subscriptions)
      .where(gte(subscriptions.startDate, since))
      .groupBy(bucket);
    return new Map(rows.map((row) => [row.bucket, row.count]));
  }

  /** Subscriptions whose end date fell in `[since, until)` and are no longer entitled: churned in that bucket. */
  async subscriptionsEndedByWeek({ since, until }: { since: Date; until: Date }): Promise<Map<Date, number>> {
    const bucket = sql<Date>`date_trunc('week', ${subscriptions.endDate})`.mapWith(subscriptions.endDate).as('bucket');
    const rows = await this.db
      .select({ bucket, count: count() })
      .from(subscriptions)
      .where(
        and(
          gte(subscriptions.endDate, since),
          lt(subscriptions.endDate, until),
          inArray(subscriptions.status, CHURNED_STATUSES),
        ),
      )
      .groupBy(bucket);
    return new Map(rows.map((row) => [row.bucket, row.count]));
  }

  /** Entitled subscriptions live at `moment` (started before, ending after), by distinct user. */
  async activeSubscriptionsAsOf(moment: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: countDistinct(subscriptions.userId) })
      .from(subscriptions)
      .where(
        and(
          lte(subscriptions.startDate, moment),
          gt(subscriptions.endDate, moment),
          inArray(subscriptions.status, ENTITLED_STATUSES),
        ),
      );
    return row?.count ?? 0;
  }

  /** Subscriptions whose start date fell in `[since, until)`. */
  async subscriptionsStartedInRange({ since, until }: { since: Date; until: Date }): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(subscriptions)
      .where(and(gte(subscriptions.startDate, since), lt(subscriptions.startDate, until)));
    return row?.count ?? 0;
  }

  /** Subscriptions that churned (CANCELED/EXPIRED) with an end date in `[since, until)`. */
  async subscriptionsEndedInRange({ since, until }: { since: Date; until: Date }): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(subscriptions)
      .where(
        and(
          gte(subscriptions.endDate, since),
          lt(subscriptions.endDate, until),
          inArray(subscriptions.status, CHURNED_STATUSES),
        ),
      );
    return row?.count ?? 0;
  }

  /** `[activePaid, activeGifted]` entitled subscriptions live at `moment`. Gifted = GIFT provider (non-cash). */
  async activeSplitPaidVsGift(moment: Date): Promise<[number, number]> {
    const isGift = sql<boolean>`${subscriptions.providerId} = ${PaymentProvider.GIFT}`.as('is_gift');
    const rows = await this.db
      .select({ isGift, count: count() })
      .from(subscriptions)
      .where(
        and(
          lte(subscriptions.startDate, moment),
          gt(subscriptions.endDate, moment),
          inArray(subscriptions.status, ENTITLED_STATUSES),
        ),
      )
      .groupBy(isGift);
    let paid = 0;
    let gifted = 0;
    for (const row of rows) {
      if (row.isGift) gifted = row.count;
      else paid += row.count;
    }
    return [paid, gifted];
  }

  /**
   * Active paid (non-gift) entitled subscriptions live at `moment`: one row per (product, currency) with a count,
   * so the service can price each product and compute MRR per currency.
   */
  async activePaidSubscriptionsAsOf(moment: Date): Promise<ActivePaidRow[]> {
    return this.db
      .select({ productId: subscriptions.productId, currency: subscriptions.currency, count: count() })
      .from(subscriptions)
      .where(
        and(
          lte(subscriptions.startDate, moment),
          gt(subscriptions.endDate, moment),
          inArray(subscriptions.status, ENTITLED_STATUSES),
          ne(subscriptions.providerId, PaymentProvider.GIFT),
        ),
      )
      .groupBy(subscriptions.productId, subscriptions.currency);
  }

  async subscriptionStatusCounts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: subscriptions.status, count: count() })
      .from(subscriptions)
      .groupBy(subscriptions.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async giftedSubscriptionsCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(subscriptions)
      .where(eq(subscriptions.providerId, PaymentProvider.GIFT));
    return row?.count ?? 0;
  }

  /** Cancellation reasons over churned (CANCELED/EXPIRED) rows. */
  async churnByReason(): Promise<Record<string, number>> {
    const reason = sql<string>`coalesce(${subscriptions.cancellationReason}, 'unknown')`.as('reason');
    const rows = await this.db
      .select({ reason, count: count() })
      .from(subscriptions)
      .where(inArray(subscriptions.status, CHURNED_STATUSES))
      .groupBy(reason);
    return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
  }
}
