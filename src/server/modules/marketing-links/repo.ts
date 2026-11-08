/**
 * Marketing links: the registry of acquisition codes and the per-code results.
 *
 * Results come from `users.referral_code` (first touch) and `payments`. What counts as *activity* is the app's call:
 * `statsByCode` takes two SQL queries (rows labelled `user_id`, `at`) that the service resolves from the app's
 * `MarketingLinksConfig`; `defaultActivity()` is the fallback (the user opened the app on that day).
 */
import { and, desc, eq, isNotNull, max, min, ne, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type MarketingLink, marketingLinks, PaymentProvider, PaymentStatus, payments, users } from '../../db/schema';

export const RETENTION_DAYS = [1, 7, 30] as const;

export interface CodeStats {
  users: number;
  activated: number;
  payers: number;
  firstUserAt: Date | null;
  lastUserAt: Date | null;
  eligibleD1: number;
  returnedD1: number;
  eligibleD7: number;
  returnedD7: number;
  eligibleD30: number;
  returnedD30: number;
}

export interface CodePayment {
  code: string;
  currency: string;
  amount: number;
  createdAt: Date;
  /** Made by the user, not an automatic renewal charge. */
  isPurchase: boolean;
}

/**
 * Activity when the app defines none: the days the user opened the app.
 *
 * `users.last_activity_date` is a calendar date (set at every app session), so the row's `at` is the END of that day:
 * "active on calendar day >= sign-up day + N" counts as returned after N days. (Midnight would undercount every
 * `returnedDN` by about a day.)
 */
export const defaultActivity = (): SQL =>
  sql`select users.id as user_id, (users.last_activity_date + interval '1 day')::timestamptz as at from users where users.last_activity_date is not null`;

const countWhere = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

export class MarketingLinksRepo extends BaseRepo<typeof marketingLinks> {
  constructor(db: Db) {
    super(db, marketingLinks, marketingLinks.id);
  }

  async getByCode(code: string): Promise<MarketingLink | null> {
    const rows = await this.db.select().from(marketingLinks).where(eq(marketingLinks.code, code));
    return rows[0] ?? null;
  }

  listAll(): Promise<MarketingLink[]> {
    return this.db.select().from(marketingLinks).orderBy(desc(marketingLinks.createdAt));
  }

  /**
   * Per acquisition code (`users.referral_code`, first touch): users, activated, payers, first/last sign-up, and
   * retention: of the users signed up at least N days ago (`eligibleDN`), how many were active N or more days after
   * signing up (`returnedDN`).
   *
   * `activation` rows make a user `activated`; `activity` rows (their latest `at`) decide retention. Both are
   * correlated per user (EXISTS / scalar subquery), so Postgres pushes the user filter into them and uses their
   * `user_id` indexes. Gifts (provider GIFT) aren't payments.
   *
   * The correlated fragments name `users` and `payments` in the SQL text: Drizzle drops the table qualifier of a
   * column in a single-table query, which would turn `payments.user_id = users.id` into `user_id = id`.
   */
  async statsByCode({ activation, activity }: { activation: SQL; activity: SQL }): Promise<Map<string, CodeStats>> {
    const perUser = this.db
      .select({
        code: users.referralCode,
        createdAt: users.createdAt,
        activated: sql<boolean>`exists (select 1 from (${activation}) as act where act.user_id = users.id)`.as(
          'activated',
        ),
        paid: sql<boolean>`exists (select 1 from payments where payments.user_id = users.id and payments.status = ${PaymentStatus.SUCCEEDED} and payments.provider_id <> ${PaymentProvider.GIFT})`.as(
          'paid',
        ),
        lastActiveAt:
          sql<Date | null>`(select max(acts.at) from (${activity}) as acts where acts.user_id = users.id)`.as(
            'last_active_at',
          ),
      })
      .from(users)
      .where(isNotNull(users.referralCode))
      .as('per_user');

    const retention = (days: number) => {
      const interval = sql.raw(`make_interval(days => ${days})`);
      const oldEnough = sql`${perUser.createdAt} <= now() - ${interval}`;
      const cameBack = sql`${perUser.lastActiveAt} >= ${perUser.createdAt} + ${interval}`;
      return {
        eligible: countWhere(oldEnough),
        returned: countWhere(sql`${oldEnough} and ${cameBack}`),
      };
    };
    const d1 = retention(1);
    const d7 = retention(7);
    const d30 = retention(30);

    const rows = await this.db
      .select({
        code: perUser.code,
        users: sql<number>`count(*)`.mapWith(Number),
        activated: countWhere(sql`${perUser.activated}`),
        payers: countWhere(sql`${perUser.paid}`),
        firstUserAt: min(perUser.createdAt),
        lastUserAt: max(perUser.createdAt),
        eligibleD1: d1.eligible,
        returnedD1: d1.returned,
        eligibleD7: d7.eligible,
        returnedD7: d7.returned,
        eligibleD30: d30.eligible,
        returnedD30: d30.returned,
      })
      .from(perUser)
      .groupBy(perUser.code);

    const stats = new Map<string, CodeStats>();
    for (const { code, ...rest } of rows) if (code !== null) stats.set(code, rest);
    return stats;
  }

  /**
   * Every SUCCEEDED non-gift payment of a user with an acquisition code, oldest first. REFUNDED payments drop out
   * by status.
   */
  async paymentsByCode(): Promise<CodePayment[]> {
    const rows = await this.db
      .select({
        code: users.referralCode,
        currency: payments.currency,
        amount: payments.amount,
        createdAt: payments.createdAt,
        isRecurring: payments.isRecurring,
      })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.userId))
      .where(
        and(
          eq(payments.status, PaymentStatus.SUCCEEDED),
          ne(payments.providerId, PaymentProvider.GIFT),
          isNotNull(users.referralCode),
        ),
      )
      .orderBy(payments.createdAt);
    return rows.map(({ code, isRecurring, ...rest }) => ({ ...rest, code: code ?? '', isPurchase: !isRecurring }));
  }
}
