/**
 * Port of core's `tests/unit/test_analytics_math.py`, `tests/integration/test_analytics_service.py` and the analytics
 * part of `testing/contracts/admin_statistics.py`. The database may hold other tests' rows, so totals are lower
 * bounds unless the test uses its own currency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentProvider, PaymentStatus, SubscriptionStatus, UserRole } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp, TestServices } from '../../testing';
import { type PaymentProduct, productPriceIn as priceIn } from '../payments/products';
import { clamp, growthPct, isoDate, roundHalfEven, weekStart } from './math';
import { AnalyticsService } from './service';
import { pay, servicesFor, subscribe } from './test-support';

interface Price {
  amount: number;
  currency: string;
}
interface Product {
  productId: string;
  durationDays: number;
  recurring?: boolean;
  prices: Record<string, Price>;
}

const product = (p: Product) => ({ recurring: true, ...p });
const catalogOf = (...products: ReturnType<typeof product>[]) => ({
  getProduct: (id: string) => products.find((p) => p.productId === id) ?? null,
});

const CATALOG = catalogOf(
  product({
    productId: 'AN_MONTH',
    durationDays: 30,
    prices: { RUB: { amount: 555, currency: 'RUB' }, ZZE: { amount: 10, currency: 'ZZE' } },
  }),
  product({ productId: 'AN_WEEK', durationDays: 7, prices: { RUB: { amount: 222, currency: 'RUB' } } }),
);

class CatalogServices extends TestServices {
  override readonly products = CATALOG as never;
}

describe('helpers', () => {
  it('growth is null when the prior window is zero', () => {
    expect(growthPct(100, 0)).toBeNull();
    expect(growthPct(0, 0)).toBeNull();
  });

  it('growth is computed when the prior window is not zero', () => {
    expect(growthPct(150, 100)).toBe(50);
    expect(growthPct(50, 100)).toBe(-50);
  });

  it('clamp', () => {
    expect(clamp(100_000, 1, 365)).toBe(365);
    expect(clamp(0, 1, 365)).toBe(1);
    expect(clamp(30, 1, 365)).toBe(30);
  });

  it('week start is Monday midnight UTC', () => {
    expect(weekStart(new Date('2026-09-26T15:30:00Z'))).toEqual(new Date('2026-09-21T00:00:00Z'));
    expect(weekStart(new Date('2026-09-21T00:00:00Z'))).toEqual(new Date('2026-09-21T00:00:00Z'));
    expect(isoDate(weekStart(new Date('2026-09-27T23:59:59Z')))).toBe('2026-09-21');
  });

  it("roundHalfEven is Python's round()", () => {
    expect(roundHalfEven(333.3333, 2)).toBe(333.33);
    expect(roundHalfEven(0.125, 2)).toBe(0.12);
    expect(roundHalfEven(0.375, 2)).toBe(0.38);
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
    expect(roundHalfEven(1.1, 2)).toBe(1.1);
    expect(roundHalfEven(-0.125, 2)).toBe(-0.12);
    expect(roundHalfEven(1234, 2)).toBe(1234);
  });
});

// The analytics reads only these members of a product
const productPriceIn = (product: object | null, currency: string) =>
  priceIn(product as PaymentProduct | null, currency);

describe('productPriceIn', () => {
  it('reads the prices mapping', () => {
    const p = product({ productId: 'm', durationDays: 30, prices: { RUB: { amount: 555, currency: 'RUB' } } });
    expect(productPriceIn(p, 'RUB')).toEqual({ amount: 555, currency: 'RUB' });
    expect(productPriceIn(p, 'USD')).toBeNull(); // never another currency's price
  });

  it('without a mapping keeps getPriceFor only in the same currency', () => {
    const single = { recurring: true, durationDays: 30, getPriceFor: () => ({ amount: 5, currency: 'USD' }) };
    expect(productPriceIn(single, 'USD')).toEqual({ amount: 5, currency: 'USD' });
    expect(productPriceIn(single, 'RUB')).toBeNull();
  });

  it('no price at all is null', () => {
    const throwing = {
      recurring: true,
      durationDays: 30,
      getPriceFor: () => {
        throw new Error('no prices');
      },
    };
    expect(productPriceIn(throwing, 'RUB')).toBeNull();
    expect(productPriceIn(null, 'RUB')).toBeNull();
  });
});

describe('foldMrr', () => {
  const service = (catalog: unknown) =>
    new AnalyticsService(null as never, null as never, { products: catalog } as never, null);

  it('normalizes to a month and excludes what it cannot price', () => {
    const catalog = catalogOf(
      product({ productId: 'MONTH', durationDays: 30, prices: { RUB: { amount: 555, currency: 'RUB' } } }),
      product({ productId: 'WEEK', durationDays: 7, prices: { RUB: { amount: 222, currency: 'RUB' } } }),
      product({
        productId: 'ONCE',
        durationDays: 30,
        recurring: false,
        prices: { RUB: { amount: 99, currency: 'RUB' } },
      }),
      product({ productId: 'USD_ONLY', durationDays: 30, prices: { USD: { amount: 5, currency: 'USD' } } }),
    );
    const rows = [
      { productId: 'MONTH', currency: 'RUB', count: 2 },
      { productId: 'WEEK', currency: 'RUB', count: 1 },
      { productId: 'NOPE', currency: 'RUB', count: 3 }, // unknown product
      { productId: 'ONCE', currency: 'RUB', count: 4 }, // not recurring
      { productId: 'USD_ONLY', currency: 'RUB', count: 5 }, // no RUB price
    ];

    const { mrr, subs, excluded } = service(catalog).foldMrr(rows);

    expect(mrr.get('RUB')).toBeCloseTo(2 * 555 + 222 * (30 / 7));
    expect(Object.fromEntries(subs)).toEqual({ RUB: 3 });
    expect(excluded).toBe(3 + 4 + 5);
  });

  it('without a catalog everything is excluded', () => {
    const { mrr, subs, excluded } = service(null).foldMrr([{ productId: 'MONTH', currency: 'RUB', count: 2 }]);
    expect(mrr.size).toBe(0);
    expect(subs.size).toBe(0);
    expect(excluded).toBe(2);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: wire JSON, asserted field by field
const json = async (res: Response): Promise<any> => res.json();

describe('analytics on the database', () => {
  let t: TestApp<CatalogServices>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let regular: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await createTestApp<CatalogServices>({ servicesClass: CatalogServices });
    admin = await createUser(t.db, { role: UserRole.ADMIN });
    regular = await createUser(t.db);
  });
  afterAll(() => t.close());

  const service = () => servicesFor(t, CatalogServices).analytics;

  describe('revenue timeseries', () => {
    it('stars and cash are separate series, never summed', async () => {
      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 500, currency: 'RUB', providerId: PaymentProvider.YOOKASSA });
      await pay(t.db, user.id, { amount: 42, currency: 'XTR', providerId: PaymentProvider.TELEGRAM_STARS });

      const result = await service().revenueTimeseries({ granularity: 'day', days: 30 });

      const rub = result.series.filter((s) => s.currency === 'RUB');
      const xtr = result.series.filter((s) => s.currency === 'XTR');
      expect(rub.length).toBeGreaterThan(0);
      expect(rub.every((s) => s.isCash)).toBe(true);
      expect(xtr.length).toBeGreaterThan(0);
      expect(xtr.every((s) => !s.isCash)).toBe(true);
      expect(rub.flatMap((s) => s.points).reduce((n, p) => n + p.amount, 0)).toBeGreaterThanOrEqual(500);
      expect(xtr.flatMap((s) => s.points).reduce((n, p) => n + p.amount, 0)).toBeGreaterThanOrEqual(42);
    });

    it('failed payments are excluded', async () => {
      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 7, currency: 'ZZA', status: PaymentStatus.FAILED });

      const result = await service().revenueTimeseries({ granularity: 'day', days: 30 });

      expect(result.series.every((s) => s.currency !== 'ZZA')).toBe(true);
    });

    it('days are clamped to the max', async () => {
      const result = await service().revenueTimeseries({ granularity: 'day', days: 100_000 });
      expect(result.days).toBe(365);
    });

    it('the second call is served from the cache', async () => {
      const first = await service().revenueTimeseries({ granularity: 'day', days: 7 });
      expect(await t.fakes.redis.exists('admin:analytics:revenue:day:7')).toBe(1);

      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 12345, currency: 'RUB' });

      const second = await service().revenueTimeseries({ granularity: 'day', days: 7 });
      expect(second).toEqual(first);
    });
  });

  describe('subscription trend', () => {
    it('weeks are clamped and the result is cached', async () => {
      const result = await service().subscriptionTrend({ weeks: 100_000 });
      expect(result.weeks).toBe(26);
      expect(result.points).toHaveLength(26);

      await service().subscriptionTrend({ weeks: 4 });
      expect(await t.fakes.redis.exists('admin:analytics:subtrend:4')).toBe(1);
    });
  });

  describe('subscription breakdown', () => {
    it('gifted and paid active split', async () => {
      await subscribe(t.db, { productId: 'AN_GIFT', providerId: PaymentProvider.GIFT });
      await subscribe(t.db, { productId: 'AN_MONTH' });

      const breakdown = await service().subscriptionBreakdown();

      expect(breakdown.gifted).toBeGreaterThanOrEqual(1);
      expect(breakdown.activeGifted).toBeGreaterThanOrEqual(1);
      expect(breakdown.activePaid).toBeGreaterThanOrEqual(1);
      expect(breakdown.byStatus[SubscriptionStatus.ACTIVE] ?? 0).toBeGreaterThanOrEqual(2);
    });

    it('churn rate is a number or null and net new is signed', async () => {
      const breakdown = await service().subscriptionBreakdown();

      expect(breakdown.churnPeriodDays).toBe(30);
      expect(breakdown.churnRate === null || typeof breakdown.churnRate === 'number').toBe(true);
      expect(breakdown.netNew).toBe(breakdown.newInPeriod - breakdown.churnedInPeriod);
    });
  });

  describe('revenue KPIs', () => {
    it('ARPPU and avg payment per currency', async () => {
      const user = await createUser(t.db);
      // The windows end at the service's `now`, and the database's clock (the default `created_at`) can run ahead of
      // this process's: Docker's VM does, by some milliseconds. So the rows are stamped from this clock, a second back.
      const createdAt = new Date(Date.now() - 1000);
      await pay(t.db, user.id, { amount: 300, currency: 'ZZB', createdAt });
      await pay(t.db, user.id, { amount: 100, currency: 'ZZB', createdAt });

      const result = await service().revenueKpis();

      const row = result.kpis.find((r) => r.currency === 'ZZB');
      expect(row).toMatchObject({ payingUsers: 1, paymentCount: 2, revenue: 400, arppu: 400, avgPayment: 200 });
      const growth = result.growth.find((g) => g.currency === 'ZZB');
      expect(growth?.thisWeek).toBe(400);
      expect(growth?.lastWeek).toBe(0);
      expect(growth?.weekGrowthPct).toBeNull(); // growth from zero is undefined
    });

    it('non-cash is excluded', async () => {
      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 55, currency: 'XTR', providerId: PaymentProvider.TELEGRAM_STARS });
      await pay(t.db, user.id, { amount: 10, currency: 'ZZC', providerId: PaymentProvider.GIFT });

      const result = await service().revenueKpis();

      expect(result.kpis.every((r) => r.currency !== 'XTR' && r.currency !== 'ZZC')).toBe(true);
      expect(result.growth.every((g) => g.currency !== 'XTR' && g.currency !== 'ZZC')).toBe(true);
    });
  });

  describe('MRR', () => {
    it('per currency from the injected catalog', async () => {
      await subscribe(t.db, { productId: 'AN_MONTH' });
      await subscribe(t.db, { productId: 'AN_WEEK', endDate: new Date(Date.now() + 5 * 86_400_000) });

      const result = await service().mrr();

      const rub = result.rows.find((r) => r.currency === 'RUB');
      expect(rub?.mrr).toBeGreaterThanOrEqual(555 + 222 * (30 / 7) - 0.5);
      expect(rub?.subscriptions).toBeGreaterThanOrEqual(2);
    });

    it('unknown product and foreign currency are excluded', async () => {
      const before = (await service().mrr()).excluded;
      await subscribe(t.db, { productId: 'AN_UNKNOWN' });
      await subscribe(t.db, { productId: 'AN_MONTH', currency: 'USD' }); // no USD price

      const result = await service().mrr();

      expect(result.excluded).toBeGreaterThanOrEqual(before + 2);
      expect(result.rows.every((r) => r.currency !== 'USD')).toBe(true);
    });

    it('gifted subscriptions are not MRR', async () => {
      await subscribe(t.db, { productId: 'AN_MONTH', providerId: PaymentProvider.GIFT, currency: 'ZZE' });

      const result = await service().mrr();

      // Priceable in ZZE, but a gift brings no recurring cash: filtered out in SQL, not excluded.
      expect(result.rows.every((r) => r.currency !== 'ZZE')).toBe(true);
    });
  });

  describe('admin routes (contract)', () => {
    const PATHS = [
      '/admin/analytics/revenue-timeseries',
      '/admin/analytics/revenue-kpis',
      '/admin/analytics/subscription-trend',
      '/admin/analytics/subscription-breakdown',
      '/admin/analytics/mrr',
    ];
    const asAdmin = () => ({ headers: asUser(admin) });
    const isNumber = (v: unknown) => typeof v === 'number';
    const isOptionalNumber = (v: unknown) => v === null || isNumber(v);

    it.each(PATHS)('admin gets 200 on %s', async (path) => {
      const res = await t.client.get(path, asAdmin());
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it.each(PATHS)('non-admin is forbidden on %s', async (path) => {
      const res = await t.client.get(path, { headers: asUser(regular) });
      expect(res.status).toBe(403);
    });

    it('revenue timeseries shape', async () => {
      const res = await t.client.get('/admin/analytics/revenue-timeseries?granularity=week&days=30', asAdmin());
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.granularity).toBe('week');
      expect(data.days).toBe(30);
      expect(Array.isArray(data.buckets)).toBe(true);
      for (const series of data.series) {
        expect(typeof series.currency).toBe('string');
        expect(typeof series.provider).toBe('string');
        expect(typeof series.is_cash).toBe('boolean');
        // Every series shares the bucket axis.
        expect(series.points.map((p: { bucket: string }) => p.bucket)).toEqual(data.buckets);
      }
    });

    it('subscription trend shape', async () => {
      const data = await json(await t.client.get('/admin/analytics/subscription-trend?weeks=8', asAdmin()));
      expect(data.weeks).toBe(8);
      expect(data.points).toHaveLength(8);
      for (const point of data.points) {
        expect(typeof point.bucket).toBe('string');
        for (const key of ['new', 'ended', 'active']) expect(Number.isInteger(point[key])).toBe(true);
      }
    });

    it('revenue KPIs shape', async () => {
      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 777, currency: 'RUB' });
      const data = await json(await t.client.get('/admin/analytics/revenue-kpis', asAdmin()));
      expect(data.kpis.length).toBeGreaterThan(0);
      for (const row of data.kpis) {
        expect(typeof row.currency).toBe('string');
        expect(Number.isInteger(row.paying_users)).toBe(true);
        expect(isNumber(row.revenue)).toBe(true);
        expect(Number.isInteger(row.payment_count)).toBe(true);
        expect(isOptionalNumber(row.arppu)).toBe(true);
        expect(isOptionalNumber(row.avg_payment)).toBe(true);
      }
      for (const row of data.growth) {
        expect(isOptionalNumber(row.month_growth_pct)).toBe(true);
        expect(isOptionalNumber(row.week_growth_pct)).toBe(true);
      }
    });

    it('subscription breakdown shape', async () => {
      const data = await json(await t.client.get('/admin/analytics/subscription-breakdown', asAdmin()));
      expect(typeof data.by_status).toBe('object');
      expect(Number.isInteger(data.gifted)).toBe(true);
      expect(typeof data.churn_by_reason).toBe('object');
      expect(Number.isInteger(data.active_paid)).toBe(true);
      expect(Number.isInteger(data.active_gifted)).toBe(true);
      expect(data.churn_period_days).toBe(30);
      expect(isOptionalNumber(data.churn_rate)).toBe(true);
      expect(data.net_new).toBe(data.new_in_period - data.churned_in_period);
    });

    it('MRR shape', async () => {
      const data = await json(await t.client.get('/admin/analytics/mrr', asAdmin()));
      expect(Array.isArray(data.rows)).toBe(true);
      expect(Number.isInteger(data.excluded)).toBe(true);
      for (const row of data.rows) {
        expect(typeof row.currency).toBe('string');
        expect(isNumber(row.mrr)).toBe(true);
        expect(isNumber(row.mrr_prev)).toBe(true);
        expect(isOptionalNumber(row.growth_pct)).toBe(true);
        expect(Number.isInteger(row.subscriptions)).toBe(true);
      }
    });

    it('days over the max is a 422', async () => {
      const res = await t.client.get('/admin/analytics/revenue-timeseries?days=366', asAdmin());
      expect(res.status).toBe(422);
    });

    it('an unknown granularity is a 422', async () => {
      const res = await t.client.get('/admin/analytics/revenue-timeseries?granularity=month', asAdmin());
      expect(res.status).toBe(422);
    });

    it('weeks over the max is a 422', async () => {
      const res = await t.client.get('/admin/analytics/subscription-trend?weeks=27', asAdmin());
      expect(res.status).toBe(422);
    });

    it('stars and cash are separate series over HTTP, and Stars stay out of the cash KPIs', async () => {
      const user = await createUser(t.db);
      await pay(t.db, user.id, { amount: 42, currency: 'XTR', providerId: PaymentProvider.TELEGRAM_STARS });
      await pay(t.db, user.id, { amount: 500, currency: 'RUB', providerId: PaymentProvider.YOOKASSA });

      // days=3 is a key no earlier test cached
      const { series } = await json(await t.client.get('/admin/analytics/revenue-timeseries?days=3', asAdmin()));
      type S = { currency: string; provider: string; is_cash: boolean; points: { amount: number }[] };
      const xtr = series.filter((s: S) => s.currency === 'XTR');
      const rub = series.filter((s: S) => s.currency === 'RUB' && s.provider === PaymentProvider.YOOKASSA);
      expect(xtr.length).toBeGreaterThan(0);
      expect(xtr.every((s: S) => s.is_cash === false)).toBe(true);
      expect(rub.every((s: S) => s.is_cash === true)).toBe(true);
      const total = (list: S[]) => list.flatMap((s) => s.points).reduce((n, p) => n + p.amount, 0);
      expect(total(xtr)).toBeGreaterThanOrEqual(42);
      expect(total(rub)).toBeGreaterThanOrEqual(500);

      const kpis = (await json(await t.client.get('/admin/analytics/revenue-kpis', asAdmin()))).kpis;
      expect(kpis.every((row: { currency: string }) => row.currency !== 'XTR')).toBe(true);
    });
  });
});
