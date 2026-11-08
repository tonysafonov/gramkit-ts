/**
 * Schemas for the admin money analytics (`/admin/analytics/*`).
 *
 * Money is per currency and never summed across currencies: revenue surfaces carry a list of per-currency series, and
 * the non-cash providers (TELEGRAM_STARS / XTR and GIFT) are their own series, never folded into the cash totals.
 * The service works with the camelCase types below; the mappers produce the snake_case wire shape.
 */
import { z } from 'zod';

export const RevenueTimeseriesQuery = z.object({
  granularity: z.enum(['day', 'week']).default('day'),
  days: z.coerce.number().int().min(1).max(365).default(90),
});

export const SubscriptionTrendQuery = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(12),
});

export interface RevenuePoint {
  bucket: string;
  amount: number;
  count: number;
}

export interface RevenueSeries {
  currency: string;
  provider: string;
  isCash: boolean;
  points: RevenuePoint[];
}

export interface RevenueTimeseries {
  granularity: string;
  /** The (clamped) lookback window actually used. */
  days: number;
  /** Shared bucket axis (ISO dates), oldest to newest. */
  buckets: string[];
  series: RevenueSeries[];
}

export interface RevenueKpiRow {
  currency: string;
  payingUsers: number;
  revenue: number;
  paymentCount: number;
  /** `null` when there are no paying users (divide-by-zero guard). */
  arppu: number | null;
  avgPayment: number | null;
}

export interface RevenuePeriodGrowthRow {
  currency: string;
  thisMonth: number;
  lastMonth: number;
  monthGrowthPct: number | null;
  thisWeek: number;
  lastWeek: number;
  weekGrowthPct: number | null;
}

export interface RevenueKpis {
  kpis: RevenueKpiRow[];
  growth: RevenuePeriodGrowthRow[];
}

export interface SubscriptionTrendPoint {
  bucket: string;
  new: number;
  ended: number;
  active: number;
}

export interface SubscriptionTrend {
  weeks: number;
  points: SubscriptionTrendPoint[];
}

export interface SubscriptionBreakdown {
  byStatus: Record<string, number>;
  gifted: number;
  churnByReason: Record<string, number>;
  activePaid: number;
  activeGifted: number;
  churnPeriodDays: number;
  churnedInPeriod: number;
  activeAtPeriodStart: number;
  churnRate: number | null;
  newInPeriod: number;
  netNew: number;
}

export interface MrrCurrencyRow {
  currency: string;
  mrr: number;
  mrrPrev: number;
  growthPct: number | null;
  subscriptions: number;
}

export interface Mrr {
  rows: MrrCurrencyRow[];
  /** Active paid subscriptions dropped because their product or price couldn't be resolved. */
  excluded: number;
}

export const toRevenueTimeseriesResponse = (r: RevenueTimeseries) => ({
  granularity: r.granularity,
  days: r.days,
  buckets: r.buckets,
  series: r.series.map((s) => ({
    currency: s.currency,
    provider: s.provider,
    is_cash: s.isCash,
    points: s.points.map((p) => ({ bucket: p.bucket, amount: p.amount, count: p.count })),
  })),
});

export const toRevenueKpisResponse = (r: RevenueKpis) => ({
  kpis: r.kpis.map((k) => ({
    currency: k.currency,
    paying_users: k.payingUsers,
    revenue: k.revenue,
    payment_count: k.paymentCount,
    arppu: k.arppu,
    avg_payment: k.avgPayment,
  })),
  growth: r.growth.map((g) => ({
    currency: g.currency,
    this_month: g.thisMonth,
    last_month: g.lastMonth,
    month_growth_pct: g.monthGrowthPct,
    this_week: g.thisWeek,
    last_week: g.lastWeek,
    week_growth_pct: g.weekGrowthPct,
  })),
});

export const toSubscriptionTrendResponse = (r: SubscriptionTrend) => ({
  weeks: r.weeks,
  points: r.points.map((p) => ({ bucket: p.bucket, new: p.new, ended: p.ended, active: p.active })),
});

export const toSubscriptionBreakdownResponse = (r: SubscriptionBreakdown) => ({
  by_status: r.byStatus,
  gifted: r.gifted,
  churn_by_reason: r.churnByReason,
  active_paid: r.activePaid,
  active_gifted: r.activeGifted,
  churn_period_days: r.churnPeriodDays,
  churned_in_period: r.churnedInPeriod,
  active_at_period_start: r.activeAtPeriodStart,
  churn_rate: r.churnRate,
  new_in_period: r.newInPeriod,
  net_new: r.netNew,
});

export const toMrrResponse = (r: Mrr) => ({
  rows: r.rows.map((row) => ({
    currency: row.currency,
    mrr: row.mrr,
    mrr_prev: row.mrrPrev,
    growth_pct: row.growthPct,
    subscriptions: row.subscriptions,
  })),
  excluded: r.excluded,
});
