import { and, count, countDistinct, desc, eq, getTableColumns, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type Subscription, SubscriptionStatus, subscriptions } from '../../db/schema';
import { type ExactTimestamp, isoformatFromPg, PG_ISO_UTC } from '../payments/utils';

/** A subscription to charge, with its end date as Python's `isoformat()` at full (microsecond) precision. */
export type ChargeableSubscription = Subscription & { endDateExact: ExactTimestamp };

/** Statuses that still grant access: ACTIVE, PAST_DUE (in dunning grace), CANCELED (until the end date). */
export const ENTITLED_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.CANCELED,
];

const LIVE_STATUSES: SubscriptionStatus[] = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE];

export class SubscriptionsRepo extends BaseRepo<typeof subscriptions> {
  constructor(db: Db) {
    super(db, subscriptions, subscriptions.id);
  }

  getByUserId(userId: string): Promise<Subscription[]> {
    return this.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  }

  async getActiveByUserId(userId: string): Promise<Subscription | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ENTITLED_STATUSES),
          gt(subscriptions.endDate, new Date()),
        ),
      )
      // Duplicate-tolerant: degrade gracefully on old duplicate rows
      .orderBy(desc(subscriptions.endDate))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The most recent ACTIVE/PAST_DUE subscription regardless of end date.
   *
   * Unlike `getActiveByUserId`, this includes subs whose end date has passed but aren't marked EXPIRED yet. Used for
   * renewal, to prevent duplicate subscriptions after downtime. PAST_DUE is included so a fresh manual payment renews
   * the existing dunning row instead of creating a duplicate.
   */
  async getRenewableByUserId(userId: string): Promise<Subscription | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, LIVE_STATUSES)))
      .orderBy(desc(subscriptions.endDate))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Most recent user-CANCELED subscription whose period ended on or after `since`.
   *
   * Resurrection backstop for `topUpSubscription`: a late provider auto-renewal can arrive just after a canceled sub's
   * end date has passed, when `getActiveByUserId` and `getRenewableByUserId` both miss it, so the renewal would create
   * a brand-new ACTIVE sub. The `since` window scopes this to an adjacent renewal (one period plus slack), so an
   * ancient cancellation can't block an unrelated future charge.
   */
  async getRecentlyCanceledByUserId(userId: string, since: Date): Promise<Subscription | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, SubscriptionStatus.CANCELED),
          gte(subscriptions.endDate, since),
        ),
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * What the renewal job should attempt to charge: ACTIVE or PAST_DUE (dunning retry) ending within the threshold.
   * `endDateExact` is the stored end date to the microsecond, for the renewal idempotency key.
   */
  async getChargeableSubscriptions(expirationThreshold: Date): Promise<ChargeableSubscription[]> {
    const rows = await this.db
      .select({
        ...getTableColumns(subscriptions),
        endDateText: sql<string>`to_char(${subscriptions.endDate} AT TIME ZONE 'UTC', ${PG_ISO_UTC})`,
      })
      .from(subscriptions)
      .where(and(inArray(subscriptions.status, LIVE_STATUSES), lte(subscriptions.endDate, expirationThreshold)));
    return rows.map(({ endDateText, ...row }) => ({
      ...row,
      endDateExact: { isoformat: isoformatFromPg(endDateText) },
    }));
  }

  /**
   * Subscriptions to expire: ACTIVE past their end date now, or PAST_DUE whose grace window has elapsed. The grace
   * cutoff is the dunning safety net: a PAST_DUE row can't grant free access forever if the renewal job stops selecting
   * it (product removed, repeated errors, ...).
   */
  getExpirableSubscriptions(now: Date, pastDueCutoff: Date): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        or(
          and(eq(subscriptions.status, SubscriptionStatus.ACTIVE), lte(subscriptions.endDate, now)),
          and(eq(subscriptions.status, SubscriptionStatus.PAST_DUE), lte(subscriptions.endDate, pastDueCutoff)),
        ),
      );
  }

  /** Users entitled to a subscription (ACTIVE / PAST_DUE / CANCELED, not yet expired). */
  async getActiveSubscribersCount(): Promise<number> {
    const [row] = await this.db
      .select({ total: countDistinct(subscriptions.userId) })
      .from(subscriptions)
      .where(and(inArray(subscriptions.status, ENTITLED_STATUSES), gt(subscriptions.endDate, new Date())));
    return row?.total ?? 0;
  }

  async countByStatus(status: SubscriptionStatus): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(subscriptions).where(eq(subscriptions.status, status));
    return row?.total ?? 0;
  }

  /**
   * Subscriptions now in `status` (CANCELED / EXPIRED) whose `canceledAt` falls in the window.
   *
   * Expiry overwrites `canceledAt`, so a CANCELED count is only reliable for recent windows (a canceled sub that has
   * since expired is counted as EXPIRED instead).
   */
  async countEndedBetween(status: SubscriptionStatus, from: Date, to: Date = new Date()): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.status, status), gte(subscriptions.canceledAt, from), lte(subscriptions.canceledAt, to)),
      );
    return row?.total ?? 0;
  }
}
