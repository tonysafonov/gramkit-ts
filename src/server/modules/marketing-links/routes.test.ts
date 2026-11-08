/**
 * Port of core's `testing/contracts/marketing_links.py`: every endpoint of the admin marketing-links router, the
 * per-code results and the audit rows of the mutating endpoints. What counts as activated / returned is app-defined,
 * so those are asserted by shape only. Codes are unique per test and rows are found by code.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLogs, PaymentProvider, PaymentStatus, UserRole } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { pay, uniq } from '../analytics/test-support';

const URL = '/admin/marketing-links';
const DAY = 86_400_000;

/* biome-ignore lint/suspicious/noExplicitAny: wire JSON, asserted field by field */
type Json = any;

describe('marketing links API', () => {
  let t: TestApp;
  let adminHeaders: Record<string, string>;
  let userHeaders: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
    adminHeaders = asUser(await createUser(t.db, { role: UserRole.ADMIN }));
    userHeaders = asUser(await createUser(t.db));
  });
  afterAll(() => t.close());

  const code = () => uniq('t');
  const post = (body: unknown, headers = adminHeaders) => t.client.post(URL, body, { headers });
  const patch = (id: number | string, body: unknown, headers = adminHeaders) =>
    t.client.patch(`${URL}/${id}`, body, { headers });
  const created = async (body: Record<string, unknown> = { code: code() }): Promise<Json> => (await post(body)).json();
  const userFrom = (referralCode: string, createdAt?: Date) =>
    createUser(t.db, { referralCode, ...(createdAt ? { createdAt } : {}) });
  const listing = async (): Promise<Json> => {
    const res = await t.client.get(URL, { headers: adminHeaders });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  };
  const byCode = (list: Json, c: string): Json => list.items.find((item: Json) => item.code === c);
  const auditRows = (action: string, c: string) =>
    t.db
      .select()
      .from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, action), eq(adminAuditLogs.targetId, c)));

  describe('create', () => {
    it('returns both links', async () => {
      const c = code();
      const response = await post({ code: c, channel: 'Test channel' });
      expect(response.status, await response.clone().text()).toBe(200);
      const body: Json = await response.json();
      expect(body.registered).toBe(true);
      expect(Number.isInteger(body.id)).toBe(true);
      expect(body.code).toBe(c);
      expect(body.channel).toBe('Test channel');
      expect(body.app_link.endsWith(`?startapp=r-${c}`)).toBe(true);
      expect(body.bot_link.endsWith(`?start=${c}`)).toBe(true);
    });

    it('only the code is required', async () => {
      const response = await post({ code: code() });
      expect(response.status).toBe(200);
      const body: Json = await response.json();
      expect(body.channel).toBeNull();
      expect(body.price_rub).toBeNull();
    });

    it('normalises the code', async () => {
      const c = code();
      const response = await post({ code: `  ${c.toUpperCase()} ` });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as Json).code).toBe(c);
    });

    it('writes an audit row', async () => {
      const c = code();
      await post({ code: c, channel: 'x' });
      const rows = await auditRows('marketing_link_create', c);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetType).toBe('marketing_link');
      expect(rows[0]?.actorRole).toBe('admin');
    });
  });

  describe('code rules', () => {
    it.each(['Bad-Code', 'a', 'a-b', 'x'.repeat(41), 'кот_1'])('malformed code %j is a 422', async (bad) => {
      expect((await post({ code: bad })).status).toBe(422);
    });

    it('a duplicate code is a 400', async () => {
      const c = code();
      expect((await post({ code: c })).status).toBe(200);
      const response = await post({ code: c, channel: 'again' });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).detail).toBe('This code is already registered');
    });

    it("the app's own code is a 400", async () => {
      const response = await post({ code: 'dailynotification' });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).detail).toBe("This code is used by the app's own notifications");
    });
  });

  describe('update', () => {
    it('archives and edits the channel', async () => {
      const link = await created({ code: code(), channel: 'x' });
      const updated = await patch(link.id, { is_archived: true, channel: ' post 2 ' });
      expect(updated.status, await updated.clone().text()).toBe(200);
      const body: Json = await updated.json();
      expect(body.is_archived).toBe(true);
      expect(body.channel).toBe('post 2');
      const cleared = await patch(link.id, { channel: '  ' });
      expect(cleared.status).toBe(200);
      const clearedBody: Json = await cleared.json();
      expect(clearedBody.channel).toBeNull();
      expect(clearedBody.is_archived).toBe(true); // untouched fields stay
    });

    it('a null archived flag leaves it unchanged', async () => {
      const link = await created();
      const response = await patch(link.id, { is_archived: null, channel: 'c' });
      expect(response.status, await response.clone().text()).toBe(200); // not a NOT NULL violation (500)
      const body: Json = await response.json();
      expect(body.is_archived).toBe(false);
      expect(body.channel).toBe('c');
    });

    it('price and date can be set and cleared', async () => {
      const link = await created();
      const set = await patch(link.id, { price_rub: 5000, published_on: '2026-09-01' });
      expect(set.status, await set.clone().text()).toBe(200);
      const setBody: Json = await set.json();
      expect([setBody.price_rub, setBody.published_on]).toEqual([5000, '2026-09-01']);
      expect(setBody.start_date).toBe('2026-09-01');
      const cleared: Json = await (await patch(link.id, { price_rub: null })).json();
      expect(cleared.price_rub).toBeNull();
      expect(cleared.published_on).toBe('2026-09-01');
      expect((await patch(link.id, { price_rub: -1 })).status).toBe(422);
    });

    it('an unknown link is a 404', async () => {
      const response = await patch(2_147_483_000, { channel: 'x' });
      expect(response.status).toBe(404);
      expect(((await response.json()) as Json).detail).toBe('Marketing link not found');
    });

    it('writes an audit row', async () => {
      const c = code();
      const link = await created({ code: c });
      await patch(link.id, { price_rub: 100, published_on: '2026-09-01' });
      const rows = await auditRows('marketing_link_update', c);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetType).toBe('marketing_link');
      expect(rows[0]?.detail).toEqual({ price_rub: 100, published_on: '2026-09-01' });
    });
  });

  describe('results', () => {
    it('count users, payers and revenue', async () => {
      const c = code();
      await post({ code: c });
      await userFrom(c);
      const payer = await userFrom(c);
      await pay(t.db, payer.id, { amount: 100 });
      await pay(t.db, payer.id, { amount: 999, providerId: PaymentProvider.GIFT }); // a gift, not money
      await pay(t.db, payer.id, { amount: 500, status: PaymentStatus.REFUNDED }); // refunded: not revenue
      const refundedOnly = await userFrom(c);
      await pay(t.db, refundedOnly.id, { amount: 300, status: PaymentStatus.REFUNDED });

      const item = byCode(await listing(), c);
      expect(item.stats.users).toBe(3);
      expect(item.stats.payers).toBe(1);
      expect(item.stats.revenue_rub).toBe(100);
      expect(item.ltv_rub).toBe(33.33);
      expect(item.stats.first_payment_at).not.toBeNull();
      expect(item.payback).toBeNull(); // no price, no verdict
      expect(item.cac_rub).toBeNull();
    });

    it('stats shape', async () => {
      const c = code();
      await userFrom(c);
      const { stats } = byCode(await listing(), c);
      const counts = ['users', 'activated', 'payers'];
      for (const kind of ['eligible', 'returned']) for (const n of [1, 7, 30]) counts.push(`${kind}_d${n}`);
      const money = ['revenue_rub', 'revenue_purchases_rub', 'revenue_d14_rub'];
      const dates = ['first_user_at', 'last_user_at', 'first_payment_at'];
      expect(Object.keys(stats).sort()).toEqual([...counts, ...money, ...dates].sort()); // the generic names only
      for (const key of counts) expect(Number.isInteger(stats[key]), key).toBe(true);
      expect(stats.activated).toBeGreaterThanOrEqual(0);
      expect(stats.activated).toBeLessThanOrEqual(stats.users);
      expect(stats.users).toBe(1);
      expect(stats.first_user_at).not.toBeNull();
    });
  });

  describe('economics', () => {
    it('a price gives CAC, LTV, ROAS and the payback day', async () => {
      const c = code();
      const published = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
      const start = new Date(`${published}T00:00:00Z`);
      await post({ code: c, price_rub: 1000, published_on: published });

      const first = await userFrom(c);
      await userFrom(c);
      await pay(t.db, first.id, { amount: 600, createdAt: new Date(start.getTime() + 3 * DAY) });
      await pay(t.db, first.id, { amount: 550, createdAt: new Date(start.getTime() + 10 * DAY) }); // RUB: no app rate
      await pay(t.db, first.id, { amount: 400, isRecurring: true, createdAt: new Date(start.getTime() + 20 * DAY) }); // after D14
      await pay(t.db, first.id, { amount: 999, providerId: PaymentProvider.GIFT });

      const item = byCode(await listing(), c);
      expect(item.stats.payers).toBe(1);
      expect(item.stats.revenue_d14_rub).toBe(1150);
      expect(item.stats.revenue_rub).toBe(1550);
      expect(item.stats.revenue_purchases_rub).toBe(1150); // the renewal isn't a purchase
      expect(item.cac_rub).toBe(500);
      expect(item.ltv_rub).toBe(775);
      expect(item.roas).toBe(1.55);
      expect(item.payback).toBe('paid_back');
      expect(item.payback_days).toBe(11); // 600 on day 4 + 550 on day 11 cover the 1000
      expect(item.start_date).toBe(published);
    });

    it('not paid back only after 14 days', async () => {
      const fresh = code();
      const old = code();
      for (const [c, daysAgo] of [
        [fresh, 3],
        [old, 20],
      ] as const) {
        const published = new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
        await post({ code: c, price_rub: 1000, published_on: published });
        await pay(t.db, (await userFrom(c)).id, { amount: 100 });
      }

      const list = await listing();
      expect(byCode(list, fresh).payback).toBe('in_progress');
      expect(byCode(list, old).roas).toBe(0.1);
      expect(byCode(list, old).payback).toBe('not_paid_back');
      expect(byCode(list, old).stats.revenue_d14_rub).toBe(0); // paid today, after its first 14 days
    });
  });

  describe('codes seen before the registry', () => {
    it('are listed', async () => {
      const legacy = code();
      const signedUp = new Date(Date.now() - 40 * DAY);
      await userFrom(legacy, signedUp);

      let item = byCode(await listing(), legacy);
      expect(item.registered).toBe(false);
      expect(item.id).toBeNull();
      expect(item.stats.users).toBe(1);
      expect(item.start_date).toBe(signedUp.toISOString().slice(0, 10)); // its first sign-up

      // Registering it later keeps its history.
      expect((await post({ code: legacy, channel: 'Old post' })).status).toBe(200);
      item = byCode(await listing(), legacy);
      expect(item.registered).toBe(true);
      expect(item.channel).toBe('Old post');
      expect(item.stats.users).toBe(1);
    });

    it('registered codes come first', async () => {
      const unregistered = code();
      const registered = code();
      await userFrom(unregistered);
      await post({ code: registered });
      const codes = (await listing()).items.map((item: Json) => item.code);
      expect(codes.indexOf(registered)).toBeLessThan(codes.indexOf(unregistered));
    });
  });

  describe('RBAC', () => {
    it('list is forbidden for a non-admin', async () => {
      expect((await t.client.get(URL, { headers: userHeaders })).status).toBe(403);
    });

    it('create is forbidden for a non-admin', async () => {
      expect((await post({ code: code() }, userHeaders)).status).toBe(403);
    });

    it('update is forbidden for a non-admin', async () => {
      const link = await created();
      expect((await patch(link.id, { is_archived: true }, userHeaders)).status).toBe(403);
    });
  });
});
