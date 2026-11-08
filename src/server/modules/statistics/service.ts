/**
 * Admin statistics: the Overview KPI snapshot and the daily owner digest.
 *
 * Both read the same 02:00-UTC-anchored windows (`StatWindows`). Core gathers the generic numbers (users, revenue,
 * product sales, subscriptions); the app's registered Overview cards and digest rows (`metrics.ts`) are awaited after
 * them, sequentially. Both reads degrade instead of throwing: on any error they log it and return zeroed data carrying
 * `error`, so the endpoint never 500s and the digest still reaches the owners.
 */
import { settings } from '../../config';
import { SubscriptionStatus } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import {
  type DailyDigest,
  type DigestPeriod,
  dailyDigest,
  digestPeriod,
  renderError,
  renderRich,
  renderText,
} from './digest';
import { type DigestRow, digestRowFns, overviewCardFns, StatWindows } from './metrics';
import type { OverviewCard, OverviewStatistics } from './schemas';

const logger = getLogger('statistics');

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Python's `str.title()`: the first letter of every run of letters upper-cased, the rest lower-cased. */
const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

/** Overview snapshot (`GET /admin/statistics/overview`) and the daily digest (job + `/stats`). */
export class StatisticsService extends BaseService {
  /** The current windows. A seam: tests spy on it to pin the windows around their seeded rows. */
  computeWindows(): StatWindows {
    return StatWindows.anchored(new Date());
  }

  /** The digest title's app name (`APP_NAME`, title-cased). A seam: tests spy on it. */
  appTitle(): string {
    return titleCase(String(settings.appName ?? 'app'));
  }

  async #digestPeriod(from: Date, to: Date): Promise<DigestPeriod> {
    const kinds = await this.repos.payments.getSucceededCountsByKind(from, to);
    return digestPeriod({
      revenue: await this.repos.payments.getRevenueByAllCurrenciesAndDate(from, to),
      newUsers: await this.repos.users.getNewUsersCount(from, to),
      purchases: kinds.first,
      renewals: kinds.recurring,
      expired: await this.repos.subscriptions.countEndedBetween(SubscriptionStatus.EXPIRED, from, to),
    });
  }

  /**
   * Data for the daily admin digest: the current 2AM-UTC day plus 7d / previous-7d context. The cron fires at 01:55
   * UTC, i.e. at the very end of the window, so "day" is a full day. Degrades gracefully: on a read error it logs and
   * returns a digest carrying `error`.
   */
  async getDailyDigest(): Promise<DailyDigest> {
    const windows = this.computeWindows();
    const now = windows.now;
    const appTitle = this.appTitle();
    const { users, subscriptions } = this.repos;

    try {
      const digest = dailyDigest({
        windowStart: windows.todayStart,
        windowEnd: now,
        day: await this.#digestPeriod(windows.todayStart, now),
        week: await this.#digestPeriod(windows.weekAgoStart, now),
        prevWeek: await this.#digestPeriod(windows.prevWeekStart, windows.weekAgoStart),
        dau: await users.getUpdatedUsersCount(windows.todayStart, now),
        wau: await users.getUpdatedUsersCount(windows.weekAgoStart, now),
        mau: await users.getUpdatedUsersCount(windows.monthAgoStart, now),
        activeSubs: await subscriptions.getActiveSubscribersCount(),
        pastDue: await subscriptions.countByStatus(SubscriptionStatus.PAST_DUE),
        canceledDay: await subscriptions.countEndedBetween(SubscriptionStatus.CANCELED, windows.todayStart, now),
        appTitle,
      });
      // App rows: sequentially, on this handle (never in parallel).
      const rows: [number, DigestRow][] = [];
      for (const [order, fn] of digestRowFns()) {
        const row = await fn(this.repos.db, windows);
        if (row !== null) rows.push([order, row]);
      }
      digest.rows = rows;
      return digest;
    } catch (err) {
      logger.error({ err }, `Error gathering daily digest: ${errorMessage(err)}`);
      const empty = digestPeriod();
      return dailyDigest({
        windowStart: windows.todayStart,
        windowEnd: now,
        day: empty,
        week: digestPeriod(),
        prevWeek: digestPeriod(),
        appTitle,
        error: errorMessage(err),
      });
    }
  }

  /** `[classic HTML text, rich HTML body]` for `sendAdminMessage`; no rich body on error. */
  formatDailyDigest(digest: DailyDigest, locale = 'en'): [string, string | null] {
    if (digest.error) return [renderError(digest, locale), null];
    return [renderText(digest, locale), renderRich(digest, locale)];
  }

  /**
   * KPI snapshot for the admin Overview dashboard. Reuses the 2AM-UTC windows, ALSO computes the immediately
   * preceding window for each range (prev day / prev week / prev month) so the frontend can render deltas. Revenue and
   * product sales stay per-currency / per-product (never summed). The app's registered cards follow, in registration
   * order.
   *
   * Degrades gracefully: on any read error it logs and returns zeroed blocks (no cards) with a populated `error` so
   * the endpoint never 500s.
   */
  async getOverviewStatistics(): Promise<OverviewStatistics> {
    const windows = this.computeWindows();
    const { now, todayStart, weekAgoStart, monthAgoStart } = windows;

    try {
      const { users: usersRepo, payments, subscriptions } = this.repos;
      const users = {
        total: await usersRepo.getUsersCount(),
        new_today: await usersRepo.getNewUsersCount(todayStart, now),
        new_this_week: await usersRepo.getNewUsersCount(weekAgoStart, now),
        new_this_month: await usersRepo.getNewUsersCount(monthAgoStart, now),
        new_prev_day: await usersRepo.getNewUsersCount(windows.prevDayStart, todayStart),
        new_prev_week: await usersRepo.getNewUsersCount(windows.prevWeekStart, weekAgoStart),
        new_prev_month: await usersRepo.getNewUsersCount(windows.prevMonthStart, monthAgoStart),
        dau: await usersRepo.getUpdatedUsersCount(todayStart, now),
        wau: await usersRepo.getUpdatedUsersCount(weekAgoStart, now),
        mau: await usersRepo.getUpdatedUsersCount(monthAgoStart, now),
      };

      // Revenue (per-currency, never summed)
      const revenue = {
        alltime: await payments.getTotalRevenueByCurrency(),
        today: await payments.getRevenueByAllCurrenciesAndDate(todayStart, now),
        this_week: await payments.getRevenueByAllCurrenciesAndDate(weekAgoStart, now),
        this_month: await payments.getRevenueByAllCurrenciesAndDate(monthAgoStart, now),
      };

      const productSales = {
        alltime: await payments.getProductSalesStats(),
        today: await payments.getProductSalesStatsByDate(todayStart, now),
      };

      const subscriptionsStats = { active_subscribers: await subscriptions.getActiveSubscribersCount() };

      // App cards: sequentially, on this handle (never in parallel).
      const cards: OverviewCard[] = [];
      for (const fn of overviewCardFns()) cards.push(await fn(this.repos.db, windows));

      return {
        date: windows.todayStr,
        users,
        revenue,
        product_sales: productSales,
        subscriptions: subscriptionsStats,
        cards,
        error: null,
      };
    } catch (err) {
      logger.error({ err }, `Error gathering overview statistics: ${errorMessage(err)}`);
      return {
        date: windows.todayStr,
        error: `Failed to gather statistics: ${errorMessage(err)}`,
        users: {
          total: 0,
          new_today: 0,
          new_this_week: 0,
          new_this_month: 0,
          new_prev_day: 0,
          new_prev_week: 0,
          new_prev_month: 0,
          dau: 0,
          wau: 0,
          mau: 0,
        },
        revenue: { alltime: {}, today: {}, this_week: {}, this_month: {} },
        product_sales: { alltime: {}, today: {} },
        subscriptions: { active_subscribers: 0 },
        cards: [],
      };
    }
  }
}
