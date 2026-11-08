/**
 * App extensions of the admin Overview and the daily owner digest.
 *
 * Core computes the generic numbers (users, revenue, subscriptions). An app adds its own through two module-level
 * registries:
 *
 * - `registerOverviewCard(key, fn)`: `fn(db, window) => OverviewCard`, one KPI tile on
 *   `GET /admin/statistics/overview` (in registration order).
 * - `registerDigestRow(key, fn, { order })`: `fn(db, window) => DigestRow | null`, a row of the digest table, a
 *   summary line under it, and/or a warning. `null` adds nothing.
 *
 * Registering a key again replaces the earlier entry, so the call is idempotent. Callbacks get the request's (or
 * job's) database handle and the stat windows. They must be read-only, and they are awaited one after another. A
 * callback that throws fails the whole read, which then degrades to `error`.
 *
 * Core digest table rows use orders 10 (revenue), 20 (new users), 40 (purchases), 50 (renewals) and 60 (expired);
 * pick an order between them to place an app row.
 */
import type { Db } from '../../db/client';
import type { OverviewCard } from './schemas';

/** The admin "day" starts at this hour (UTC); the digest cron fires just before it. */
export const DAY_ANCHOR_HOUR_UTC = 2;

const DAY_MS = 24 * 3600 * 1000;

/**
 * The day / 7-day / 30-day windows shared by the Overview and the digest. `todayStart` is the most recent 02:00 UTC;
 * the week and month start 7 and 30 days before it.
 */
export class StatWindows {
  constructor(
    readonly now: Date,
    readonly todayStart: Date,
    readonly weekAgoStart: Date,
    readonly monthAgoStart: Date,
  ) {}

  /** Windows for `now`: the day starts at the closest past 02:00 UTC. */
  static anchored(now: Date): StatWindows {
    const anchor = new Date(now);
    anchor.setUTCHours(DAY_ANCHOR_HOUR_UTC, 0, 0, 0);
    // Before 02:00 UTC the current day started yesterday.
    const todayStart = new Date(now.getUTCHours() < DAY_ANCHOR_HOUR_UTC ? anchor.getTime() - DAY_MS : anchor.getTime());
    return new StatWindows(
      now,
      todayStart,
      new Date(todayStart.getTime() - 7 * DAY_MS),
      new Date(todayStart.getTime() - 30 * DAY_MS),
    );
  }

  get todayStr(): string {
    return this.todayStart.toISOString().slice(0, 10);
  }

  /** Start of the day before the current one (that day ends at `todayStart`). */
  get prevDayStart(): Date {
    return new Date(this.todayStart.getTime() - DAY_MS);
  }

  /** Start of the 7 days before the current week (they end at `weekAgoStart`). */
  get prevWeekStart(): Date {
    return new Date(this.weekAgoStart.getTime() - 7 * DAY_MS);
  }

  /** Start of the 30 days before the current month (they end at `monthAgoStart`). */
  get prevMonthStart(): Date {
    return new Date(this.monthAgoStart.getTime() - 30 * DAY_MS);
  }

  /** True mid-day (a manual /stats): the current window isn't a full day yet. */
  get partial(): boolean {
    return (this.now.getTime() - this.todayStart.getTime()) / 1000 < 23 * 3600;
  }
}

/**
 * What an app adds to the daily digest. A table row (`label` with `day` / `week` / `prevWeek` counts) unless `line` is
 * set: then `line` is printed under the table instead. `line` is Telegram HTML: escape any user-supplied text in it.
 * `label` and `warning` are plain text (core escapes them); `warning` is added to the warning block (app warnings come
 * before core's). A row with an empty `label` and no `line` adds only its warning.
 */
export interface DigestRow {
  label: string;
  day?: number;
  week?: number;
  prevWeek?: number;
  line?: string | null;
  warning?: string | null;
}

export type OverviewCardFn = (db: Db, window: StatWindows) => Promise<OverviewCard>;
export type DigestRowFn = (db: Db, window: StatWindows) => Promise<DigestRow | null>;

/** Insertion order = render order. Exported so tests can swap them (Python's `_OVERVIEW_CARDS` / `_DIGEST_ROWS`). */
export const overviewCards = new Map<string, OverviewCardFn>();
export const digestRows = new Map<string, { order: number; fn: DigestRowFn }>();

/** Add (or replace) an Overview tile. */
export function registerOverviewCard(key: string, fn: OverviewCardFn): void {
  overviewCards.set(key, fn);
}

/** Add (or replace) a digest row. `order` places a table row among core's (10, 20, 40, 50, 60); lines and warnings keep it too. */
export function registerDigestRow(key: string, fn: DigestRowFn, { order = 100 }: { order?: number } = {}): void {
  digestRows.set(key, { order, fn });
}

/** Registered Overview card callbacks, in registration order. */
export const overviewCardFns = (): OverviewCardFn[] => [...overviewCards.values()];

/** Registered digest row callbacks with their order, sorted by order, then registration. */
export const digestRowFns = (): [number, DigestRowFn][] =>
  [...digestRows.values()]
    .map(({ order, fn }, index) => ({ order, fn, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ order, fn }): [number, DigestRowFn] => [order, fn]);
