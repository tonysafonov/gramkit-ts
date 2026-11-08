/**
 * Admin money analytics: revenue, subscriptions, MRR (`/admin/analytics/*`).
 *
 * Wraps `AnalyticsRepo` and shapes its aggregate rows. Three rules live here so they have one home:
 *
 * 1. Bounds. Every windowed read clamps its lookback (`days <= 365`, `weeks <= 26`) before touching the DB: there are
 *    no indexes on the hot columns, so unbounded scans are the risk, mitigated by bounded params and caching.
 * 2. Money is per currency, never summed. Revenue is one series per `(currency, provider)`. The non-cash providers
 *    (TELEGRAM_STARS / XTR and GIFT) stay their own series (`isCash: false`), never merged into cash revenue.
 * 3. MRR is derived, never fabricated. Each ACTIVE PAID subscription is priced from the app's product catalog and
 *    normalized to a monthly equivalent. Rows whose product or price can't be resolved are EXCLUDED and counted.
 *
 * The two heavy reads (revenue-timeseries, subscription-trend) are Redis-cached with a short TTL; the keys embed the
 * clamped params. A Redis hiccup degrades to a live read.
 */
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import { type ProductCatalog, productPriceIn } from '../payments/products';
import { clamp, growthPct, isoDate, roundHalfEven, weekStart } from './math';
import { NON_CASH_PROVIDERS } from './repo';
import type {
  Mrr,
  MrrCurrencyRow,
  RevenueKpiRow,
  RevenueKpis,
  RevenuePeriodGrowthRow,
  RevenueSeries,
  RevenueTimeseries,
  SubscriptionBreakdown,
  SubscriptionTrend,
  SubscriptionTrendPoint,
} from './schemas';

const logger = getLogger('analytics');

const MAX_DAYS = 365;
const MAX_WEEKS = 26;
const TTL_REVENUE = 120;
const TTL_SUB_TREND = 300;
/** Trailing window the churn rate and net-new subscribers are measured over. */
const CHURN_PERIOD_DAYS = 30;
/** Days in the monthly-equivalent normalization for MRR. */
const MRR_MONTH_DAYS = 30;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface MrrInputRow {
  productId: string;
  currency: string;
  count: number;
}

export class AnalyticsService extends BaseService {
  // Cache helpers ---------------------------------------------------------------------------------------------

  private async cacheGet<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.services.redis.get(key);
    } catch (err) {
      logger.warn({ err }, `analytics cache get failed for ${key}: ${err}`);
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, payload: object, ttl: number): Promise<void> {
    try {
      await this.services.redis.set(key, JSON.stringify(payload), ttl);
    } catch (err) {
      logger.warn({ err }, `analytics cache set failed for ${key}: ${err}`);
    }
  }

  // Revenue timeseries (cached) -------------------------------------------------------------------------------

  async revenueTimeseries({ granularity, days }: { granularity: string; days: number }): Promise<RevenueTimeseries> {
    const gran = granularity === 'week' ? 'week' : 'day';
    const window = clamp(days, 1, MAX_DAYS);
    const key = `admin:analytics:revenue:${gran}:${window}`;

    const cached = await this.cacheGet<RevenueTimeseries>(key);
    if (cached !== null) return cached;

    const result = await this.buildRevenueTimeseries(gran, window);
    await this.cacheSet(key, result, TTL_REVENUE);
    return result;
  }

  private async buildRevenueTimeseries(granularity: 'day' | 'week', days: number): Promise<RevenueTimeseries> {
    const since = new Date(Date.now() - days * DAY_MS);
    const rows = await this.repos.analytics.revenueTimeseries({ since, granularity });

    // The shared, ordered bucket axis (ISO date strings).
    const bucketKeys = [...new Set(rows.map((row) => isoDate(row.bucket)))].sort();

    // seriesMap[currency, provider] -> bucket -> (amount, count)
    const seriesMap = new Map<string, { currency: string; provider: string; buckets: Map<string, [number, number]> }>();
    for (const row of rows) {
      const id = JSON.stringify([row.currency, row.providerId]);
      let entry = seriesMap.get(id);
      if (!entry) {
        entry = { currency: row.currency, provider: row.providerId, buckets: new Map() };
        seriesMap.set(id, entry);
      }
      entry.buckets.set(isoDate(row.bucket), [row.amount, row.count]);
    }

    const nonCash = new Set<string>(NON_CASH_PROVIDERS);
    const series: RevenueSeries[] = [...seriesMap.values()]
      .sort((a, b) => compare(a.currency, b.currency) || compare(a.provider, b.provider))
      .map(({ currency, provider, buckets }) => ({
        currency,
        provider,
        isCash: !nonCash.has(provider),
        points: bucketKeys.map((bucket) => {
          const [amount, count] = buckets.get(bucket) ?? [0, 0];
          return { bucket, amount, count };
        }),
      }));

    return { granularity, days, buckets: bucketKeys, series };
  }

  // Revenue KPIs: paying users / ARPPU / avg payment + growth (live) ------------------------------------------

  /**
   * Per-currency cash KPIs (paying users, ARPPU, avg payment) and month/week growth. ARPPU and avg payment guard
   * divide-by-zero with `null` (a 0 would lie). Growth % is `null` when the prior window is zero. Currencies are
   * never summed; non-cash XTR/GIFT are excluded entirely.
   */
  async revenueKpis(): Promise<RevenueKpis> {
    const rows = await this.repos.analytics.revenueKpisByCurrency();
    const kpis: RevenueKpiRow[] = rows
      .map((row) => ({
        currency: row.currency,
        payingUsers: row.payingUsers,
        revenue: row.revenue,
        paymentCount: row.paymentCount,
        arppu: row.payingUsers ? row.revenue / row.payingUsers : null,
        avgPayment: row.paymentCount ? row.revenue / row.paymentCount : null,
      }))
      .sort((a, b) => compare(a.currency, b.currency));

    return { kpis, growth: await this.revenueGrowth() };
  }

  /** Current vs previous cash revenue per currency for the calendar month and a rolling 7-day week, with growth %. */
  private async revenueGrowth(): Promise<RevenuePeriodGrowthRow[]> {
    const now = new Date();

    // Calendar-month windows: this month [monthStart, now), last month [prevMonthStart, monthStart).
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    // Rolling-week windows: the last 7 days vs the 7 days before that.
    const weekFrom = new Date(now.getTime() - WEEK_MS);
    const prevWeekFrom = new Date(now.getTime() - 2 * WEEK_MS);

    const { analytics } = this.repos;
    const thisMonth = await analytics.cashRevenueInRangeByCurrency({ since: monthStart, until: now });
    const lastMonth = await analytics.cashRevenueInRangeByCurrency({ since: prevMonthStart, until: monthStart });
    const thisWeek = await analytics.cashRevenueInRangeByCurrency({ since: weekFrom, until: now });
    const lastWeek = await analytics.cashRevenueInRangeByCurrency({ since: prevWeekFrom, until: weekFrom });

    const currencies = [
      ...new Set([...thisMonth.keys(), ...lastMonth.keys(), ...thisWeek.keys(), ...lastWeek.keys()]),
    ].sort(compare);
    return currencies.map((currency) => {
      const tm = thisMonth.get(currency) ?? 0;
      const lm = lastMonth.get(currency) ?? 0;
      const tw = thisWeek.get(currency) ?? 0;
      const lw = lastWeek.get(currency) ?? 0;
      return {
        currency,
        thisMonth: tm,
        lastMonth: lm,
        monthGrowthPct: growthPct(tm, lm),
        thisWeek: tw,
        lastWeek: lw,
        weekGrowthPct: growthPct(tw, lw),
      };
    });
  }

  // Subscription trend (cached) -------------------------------------------------------------------------------

  async subscriptionTrend({ weeks }: { weeks: number }): Promise<SubscriptionTrend> {
    const window = clamp(weeks, 1, MAX_WEEKS);
    const key = `admin:analytics:subtrend:${window}`;

    const cached = await this.cacheGet<SubscriptionTrend>(key);
    if (cached !== null) return cached;

    const result = await this.buildSubscriptionTrend(window);
    await this.cacheSet(key, result, TTL_SUB_TREND);
    return result;
  }

  private async buildSubscriptionTrend(weeks: number): Promise<SubscriptionTrend> {
    const thisWeek = weekStart(new Date());
    const firstWeek = new Date(thisWeek.getTime() - (weeks - 1) * WEEK_MS);
    // The ended window reaches one week past the last bucket so `end_date < until` is inclusive.
    const until = new Date(thisWeek.getTime() + WEEK_MS);

    const weekAxis = Array.from({ length: weeks }, (_, i) => new Date(firstWeek.getTime() + i * WEEK_MS));

    const { analytics } = this.repos;
    const started = byIsoDate(await analytics.subscriptionsStartedByWeek({ since: firstWeek }));
    const ended = byIsoDate(await analytics.subscriptionsEndedByWeek({ since: firstWeek, until }));

    const points: SubscriptionTrendPoint[] = [];
    for (const week of weekAxis) {
      const bucket = isoDate(week);
      // "active" is the snapshot at the END of the bucket week.
      const active = await analytics.activeSubscriptionsAsOf(new Date(week.getTime() + WEEK_MS));
      points.push({ bucket, new: started.get(bucket) ?? 0, ended: ended.get(bucket) ?? 0, active });
    }
    return { weeks, points };
  }

  // Subscription breakdown + churn rate + net-new (live) ------------------------------------------------------

  async subscriptionBreakdown(): Promise<SubscriptionBreakdown> {
    const { analytics } = this.repos;
    const byStatus = await analytics.subscriptionStatusCounts();
    const gifted = await analytics.giftedSubscriptionsCount();
    const churnByReason = await analytics.churnByReason();

    const now = new Date();
    const periodStart = new Date(now.getTime() - CHURN_PERIOD_DAYS * DAY_MS);

    // ACTIVE gift-vs-paid split right now.
    const [activePaid, activeGifted] = await analytics.activeSplitPaidVsGift(now);

    // Churn rate over the trailing window: churned in the period / active at its start.
    const activeAtStart = await analytics.activeSubscriptionsAsOf(periodStart);
    const churned = await analytics.subscriptionsEndedInRange({ since: periodStart, until: now });
    const newInPeriod = await analytics.subscriptionsStartedInRange({ since: periodStart, until: now });
    // A 0% rate when nobody was active would mislead: null.
    const churnRate = activeAtStart ? (churned / activeAtStart) * 100 : null;

    return {
      byStatus,
      gifted,
      churnByReason,
      activePaid,
      activeGifted,
      churnPeriodDays: CHURN_PERIOD_DAYS,
      churnedInPeriod: churned,
      activeAtPeriodStart: activeAtStart,
      churnRate,
      newInPeriod,
      netNew: newInPeriod - churned,
    };
  }

  // MRR + month-over-month growth (live, per currency) --------------------------------------------------------

  /**
   * Per-currency monthly recurring revenue and MoM growth, from ACTIVE PAID subscriptions. Each is priced from the
   * app's product catalog and normalized to a monthly equivalent (`price * 30 / durationDays`). Rows whose
   * product or price can't be resolved are excluded and counted, never fabricated.
   */
  async mrr(): Promise<Mrr> {
    const now = new Date();
    const prev = new Date(now.getTime() - MRR_MONTH_DAYS * DAY_MS);

    const currentRows = await this.repos.analytics.activePaidSubscriptionsAsOf(now);
    const prevRows = await this.repos.analytics.activePaidSubscriptionsAsOf(prev);

    const current = this.foldMrr(currentRows);
    const previous = this.foldMrr(prevRows);

    const currencies = [...new Set([...current.mrr.keys(), ...previous.mrr.keys()])].sort(compare);
    const rows: MrrCurrencyRow[] = currencies.map((currency) => {
      const cur = current.mrr.get(currency) ?? 0;
      const pre = previous.mrr.get(currency) ?? 0;
      return {
        currency,
        mrr: roundHalfEven(cur, 2),
        mrrPrev: roundHalfEven(pre, 2),
        growthPct: growthPct(cur, pre),
        subscriptions: current.subs.get(currency) ?? 0,
      };
    });
    return { rows, excluded: current.excluded };
  }

  /**
   * Fold raw (productId, currency, count) rows into per-currency monthly MRR. A row is excluded (and never priced)
   * when its product is unknown (or there is no catalog), non-recurring, has no `durationDays`, or has no price in
   * the row's currency.
   */
  foldMrr(rows: MrrInputRow[]): { mrr: Map<string, number>; subs: Map<string, number>; excluded: number } {
    const catalog: ProductCatalog | null = this.services.products;
    const mrr = new Map<string, number>();
    const subs = new Map<string, number>();
    let excluded = 0;
    for (const { productId, currency, count } of rows) {
      const product = catalog?.getProduct(productId) ?? null;
      if (!product?.recurring || !product.durationDays) {
        excluded += count;
        continue;
      }
      const price = productPriceIn(product, currency);
      if (price === null) {
        // No price in the subscription's OWN currency: can't price honestly.
        excluded += count;
        continue;
      }
      const monthlyEquivalent = price.amount * (MRR_MONTH_DAYS / product.durationDays);
      mrr.set(currency, (mrr.get(currency) ?? 0) + monthlyEquivalent * count);
      subs.set(currency, (subs.get(currency) ?? 0) + count);
    }
    return { mrr, subs, excluded };
  }
}

/** Python's string order (code points), not `localeCompare`. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** DB bucket instants keyed by their UTC date. */
function byIsoDate(buckets: Map<Date, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [moment, count] of buckets) out.set(isoDate(moment), count);
  return out;
}
