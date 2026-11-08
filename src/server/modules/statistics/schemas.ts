/**
 * Wire shapes of the admin Overview dashboard (`GET /admin/statistics/overview`).
 *
 * Each block carries current-window scalars plus prior-window counts so the frontend can render deltas. Revenue and
 * product sales are PER-CURRENCY / per-product maps and are NEVER summed across currencies (no base currency exists).
 * `error` surfaces a degraded read instead of a 500: statistics gathering swallows exceptions. App-specific numbers
 * arrive as `cards`: KPI tiles registered with `registerOverviewCard`.
 */

export interface UsersStats {
  total: number;
  new_today: number;
  new_this_week: number;
  new_this_month: number;
  new_prev_day: number;
  new_prev_week: number;
  new_prev_month: number;
  dau: number;
  wau: number;
  mau: number;
}

export interface RevenueStats {
  alltime: Record<string, number>;
  today: Record<string, number>;
  this_week: Record<string, number>;
  this_month: Record<string, number>;
}

export interface ProductSalesStats {
  alltime: Record<string, number>;
  today: Record<string, number>;
}

export interface SubscriptionsStats {
  active_subscribers: number;
}

/** An app-registered KPI tile on the admin Overview. */
export interface OverviewCard {
  /** Stable id. The UI label is the i18n key `admin.overview.kpi.<key>`, else `label`. */
  key: string;
  /** Grouping. The UI section title is `admin.overview.sections.<section>`. */
  section: string;
  /** English fallback label. */
  label: string;
  /** `null` = undefined (e.g. a rate with no votes): never a misleading 0. */
  value: number | null;
  /** The same metric over the preceding window, for a delta chip (`null` = no delta). */
  previous: number | null;
  format: 'number' | 'percent' | 'currency';
  /** Only for `format: "currency"`: the currency code of `value`. */
  currency: string | null;
  /** i18n key suffix under `admin.overview.caveats` (e.g. "partialDay"). */
  caveat: string | null;
  /** Oldest -> newest points for a small trend line. */
  sparkline: number[];
}

/** An `OverviewCard` with the optional fields defaulted, as pydantic fills them. */
export function overviewCard(
  card: Pick<OverviewCard, 'key' | 'section' | 'label' | 'value'> & Partial<OverviewCard>,
): OverviewCard {
  return { previous: null, format: 'number', currency: null, caveat: null, sparkline: [], ...card };
}

export interface OverviewStatistics {
  date: string;
  users: UsersStats;
  revenue: RevenueStats;
  product_sales: ProductSalesStats;
  subscriptions: SubscriptionsStats;
  /** App-registered tiles, in registration order (empty when degraded). */
  cards: OverviewCard[];
  /** Set when statistics gathering degraded; the blocks above are then zeroed. */
  error: string | null;
}
