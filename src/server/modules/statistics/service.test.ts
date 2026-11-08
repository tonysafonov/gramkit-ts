/**
 * StatisticsService (Overview + daily digest) on the app's aggregator. The digest title comes through the `appTitle`
 * seam and the windows through `computeWindows`, both spied on. The windows are pinned around "now": rows get
 * `created_at` from the Postgres clock while the service computes its window end from the JS clock. Currencies are
 * unique per test file ("ZZQ") so revenue sums are exact. Port of `tests/integration/test_statistics_service.py`.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentProvider, PaymentStatus, payments } from '../../db/schema';
import type { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { makeServices } from '../admin/testing';
import {
  type DigestRow,
  type DigestRowFn,
  digestRows,
  type OverviewCardFn,
  overviewCards,
  registerDigestRow,
  registerOverviewCard,
  StatWindows,
} from './metrics';
import { overviewCard } from './schemas';
import { StatisticsService } from './service';

const CURRENCY = 'ZZQ';

let t: TestApp;
let services: Services;
let savedCards: [string, OverviewCardFn][];
let savedRows: [string, { order: number; fn: DigestRowFn }][];

const windowsCoveringNow = (): StatWindows => {
  const end = Date.now() + 5 * 60_000;
  const start = end - (23 * 3600 + 55 * 60) * 1000;
  const day = 24 * 3600 * 1000;
  return new StatWindows(new Date(end), new Date(start), new Date(start - 7 * day), new Date(start - 30 * day));
};

beforeAll(async () => {
  t = await createTestApp();
  services = makeServices(t);
});
afterAll(() => t.close());

// Empty registries, a fixed title and windows that cover the seeded rows.
beforeEach(async () => {
  // Python's tests each roll back; here the rows stay, and the revenue checks below are exact
  await t.db.delete(payments).where(eq(payments.currency, CURRENCY));
  savedCards = [...overviewCards];
  savedRows = [...digestRows];
  overviewCards.clear();
  digestRows.clear();
  vi.spyOn(StatisticsService.prototype, 'appTitle').mockReturnValue('Demo');
  vi.spyOn(StatisticsService.prototype, 'computeWindows').mockImplementation(windowsCoveringNow);
});
afterEach(() => {
  vi.restoreAllMocks();
  overviewCards.clear();
  digestRows.clear();
  for (const [key, value] of savedCards) overviewCards.set(key, value);
  for (const [key, value] of savedRows) digestRows.set(key, value);
});

async function pay(
  amount: number,
  {
    recurring = false,
    status = PaymentStatus.SUCCEEDED as PaymentStatus,
    productId = 'P_MONTH',
  }: { recurring?: boolean; status?: PaymentStatus; productId?: string } = {},
): Promise<void> {
  const user = await createUser(t.db, { username: `st_${randomUUID().slice(0, 8)}` });
  await t.db.insert(payments).values({
    userId: user.id,
    productId,
    providerId: PaymentProvider.YOOKASSA,
    amount,
    currency: CURRENCY,
    status,
    isRecurring: recurring,
  });
}

describe('overview', () => {
  it('populates the blocks', async () => {
    await pay(300, { productId: 'P_STATS_A' });

    const overview = await services.statistics.getOverviewStatistics();

    expect(overview.error).toBeNull();
    expect(overview.users.total).toBeGreaterThanOrEqual(1);
    expect(overview.users.new_today).toBeGreaterThanOrEqual(1);
    expect(overview.revenue.alltime[CURRENCY]).toBe(300);
    expect(overview.revenue.today[CURRENCY]).toBe(300);
    expect(overview.product_sales.alltime.P_STATS_A).toBeGreaterThanOrEqual(1);
    expect(overview.cards).toEqual([]);
  });

  it('gives registered cards the handle and the windows', async () => {
    const seen: [unknown, StatWindows][] = [];
    registerOverviewCard('orders', async (db, window) => {
      seen.push([db, window]);
      return overviewCard({ key: 'orders', section: 'shop', label: 'Orders', value: 3, previous: 2 });
    });
    registerOverviewCard('rate', async () =>
      overviewCard({ key: 'rate', section: 'shop', label: 'Rate', value: null, format: 'percent' }),
    );

    const overview = await services.statistics.getOverviewStatistics();

    expect(overview.cards.map((card) => card.key)).toEqual(['orders', 'rate']);
    expect(overview.cards[0]?.previous).toBe(2);
    expect(overview.cards[1]?.value).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(services.repos.db);
    expect(seen[0]?.[1].todayStr).toBe(overview.date);
  });

  it('degrades the whole overview when a card fails', async () => {
    registerOverviewCard('broken', async () => {
      throw new Error('card exploded');
    });

    const overview = await services.statistics.getOverviewStatistics();

    expect(overview.error).toBe('Failed to gather statistics: card exploded');
    expect(overview.cards).toEqual([]);
    expect(overview.users.total).toBe(0);
    expect(overview.revenue.alltime).toEqual({});
  });
});

describe('daily digest', () => {
  it('splits purchases and renewals and excludes canceled payments', async () => {
    await pay(100);
    await pay(100, { recurring: true });
    await pay(999, { status: PaymentStatus.CANCELED });

    const digest = await services.statistics.getDailyDigest();

    expect(digest.error).toBeNull();
    expect(digest.appTitle).toBe('Demo');
    expect(digest.day.revenue[CURRENCY]).toBe(200);
    expect(digest.week.revenue[CURRENCY]).toBe(200);
    expect(digest.day.purchases).toBeGreaterThanOrEqual(1);
    expect(digest.day.renewals).toBeGreaterThanOrEqual(1);
    expect(digest.day.newUsers).toBeGreaterThanOrEqual(3);

    const [text, rich] = services.statistics.formatDailyDigest(digest);
    expect(rich?.startsWith('<h3>📊 Demo · ')).toBe(true);
    expect(text.startsWith('<b>📊 Demo · ')).toBe(true);
  });

  it('collects registered rows in order and skips null', async () => {
    const orders: DigestRowFn = async () => ({ label: 'Orders', day: 1, week: 5, prevWeek: 4 });
    const nothing: DigestRowFn = async () => null;
    const note: DigestRowFn = async (): Promise<DigestRow> => ({ label: '', line: '📝 a note' });
    registerDigestRow('note', note, { order: 100 });
    registerDigestRow('orders', orders, { order: 30 });
    registerDigestRow('nothing', nothing, { order: 35 });

    const digest = await services.statistics.getDailyDigest();

    expect(digest.rows.map(([order, row]) => [order, row.label])).toEqual([
      [30, 'Orders'],
      [100, ''],
    ]);
    const [, rich] = services.statistics.formatDailyDigest(digest);
    expect(rich).not.toBeNull();
    const html = rich as string;
    expect(html.indexOf('<td>New users</td>')).toBeLessThan(html.indexOf('<td>Orders</td>'));
    expect(html.indexOf('<td>Orders</td>')).toBeLessThan(html.indexOf('<td>Purchases</td>'));
    expect(html).toContain('<p>📝 a note</p>');
  });

  it('degrades to an error digest when a row fails', async () => {
    registerDigestRow('broken', async () => {
      throw new Error('row <exploded>');
    });

    const digest = await services.statistics.getDailyDigest();

    expect(digest.error).toBe('row <exploded>');
    const [text, rich] = services.statistics.formatDailyDigest(digest);
    expect(rich).toBeNull();
    expect(text).toContain('row &lt;exploded&gt;');
  });
});
