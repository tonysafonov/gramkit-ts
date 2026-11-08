/**
 * Port of core's `tests/integration/repositories/test_marketing_links_repo.py`. `statsByCode` takes the app's activity
 * queries as arguments, so these pass `defaultActivity()` or a core-only query (payments): no app tables. Codes are
 * unique per test and results are looked up by code.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentProvider, PaymentStatus } from '../../db/schema';
import { Repos } from '../../repos';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { pay, uniq } from '../analytics/test-support';
import { defaultActivity, type MarketingLinksRepo } from './repo';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysFrom = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

describe('MarketingLinksRepo', () => {
  let t: TestApp;
  let repo: MarketingLinksRepo;

  beforeAll(async () => {
    t = await createTestApp();
    repo = new Repos(t.db).marketingLinks;
  });
  afterAll(() => t.close());

  const code = () => uniq('t');
  const user = (referralCode: string | null, extra: Parameters<typeof createUser>[1] = {}) =>
    createUser(t.db, { referralCode, ...extra });
  const stats = async (c: string, activation = defaultActivity(), activity = activation) => {
    const found = (await repo.statsByCode({ activation, activity })).get(c);
    if (!found) throw new Error(`no stats for ${c}`);
    return found;
  };

  describe('default activity', () => {
    it('users who opened the app are activated', async () => {
      const c = code();
      await user(c, { lastActivityDate: today() });
      await user(c); // never opened the app (e.g. came through the bot only)

      const s = await stats(c);
      expect([s.users, s.activated]).toEqual([2, 1]);
    });

    it('retention counts users active n days after sign-up', async () => {
      const c = code();
      const signedUp = new Date(Date.now() - 10 * DAY);
      await user(c, { createdAt: signedUp, lastActivityDate: dateOnly(daysFrom(signedUp, 8)) });
      await user(c, { createdAt: signedUp, lastActivityDate: dateOnly(signedUp) }); // first day only
      await user(c); // signed up now: not eligible yet

      const s = await stats(c);
      expect([s.returnedD1, s.eligibleD1]).toEqual([1, 2]);
      expect([s.returnedD7, s.eligibleD7]).toEqual([1, 2]);
      expect([s.returnedD30, s.eligibleD30]).toEqual([0, 0]);
    });

    it('active the next calendar day counts as returned after a day', async () => {
      // Sign-up at 15:00, back the next day (any hour): returnedD1. `last_activity_date` is a day, so its end is
      // what counts: its midnight would be before sign-up + 24 h.
      const c = code();
      const day0 = new Date(`${dateOnly(new Date(Date.now() - 3 * DAY))}T15:00:00Z`);
      await user(c, { createdAt: day0, lastActivityDate: dateOnly(daysFrom(day0, 1)) });

      const s = await stats(c);
      expect([s.returnedD1, s.eligibleD1]).toEqual([1, 1]);
      expect(s.returnedD7).toBe(0);
    });
  });

  describe('custom activity', () => {
    it('an app query decides activation and return', async () => {
      // Any (user_id, at) query composes: here "activated" = paid, "returned" = paid later.
      const c = code();
      const signedUp = new Date(Date.now() - 20 * DAY);
      const latePayer = await user(c, { createdAt: signedUp, lastActivityDate: today() });
      await pay(t.db, latePayer.id, { amount: 100, createdAt: daysFrom(signedUp, 9) });
      const earlyPayer = await user(c, { createdAt: signedUp });
      await pay(t.db, earlyPayer.id, { amount: 100, createdAt: new Date(signedUp.getTime() + 2 * 3_600_000) });
      await user(c, { createdAt: signedUp, lastActivityDate: today() });

      const paid = sql`select user_id, created_at as at from payments`;
      const s = await stats(c, paid);
      expect([s.users, s.activated, s.payers]).toEqual([3, 2, 2]);
      expect([s.returnedD1, s.returnedD7, s.eligibleD7]).toEqual([1, 1, 3]);
    });

    it('activation and return can differ', async () => {
      const c = code();
      const signedUp = new Date(Date.now() - 10 * DAY);
      await user(c, { createdAt: signedUp, lastActivityDate: dateOnly(daysFrom(signedUp, 8)) });

      const nobody = sql`select id as user_id, created_at as at from users where id is null`;
      const s = await stats(c, nobody, defaultActivity());
      expect([s.activated, s.returnedD7]).toEqual([0, 1]);
    });
  });

  describe('payers', () => {
    it('gifts and refunds are not payers', async () => {
      const c = code();
      const payer = await user(c);
      await pay(t.db, payer.id, { amount: 100 });
      const gifted = await user(c);
      await pay(t.db, gifted.id, { amount: 100, providerId: PaymentProvider.GIFT });
      const refunded = await user(c);
      await pay(t.db, refunded.id, { amount: 100, status: PaymentStatus.REFUNDED });

      const s = await stats(c);
      expect([s.users, s.payers]).toEqual([3, 1]);
    });
  });

  describe('paymentsByCode', () => {
    it('only succeeded non-gift payments of coded users', async () => {
      const c = code();
      const u = await user(c);
      const now = Date.now();
      await pay(t.db, u.id, { amount: 100, createdAt: new Date(now - 2 * DAY) });
      await pay(t.db, u.id, { amount: 200, isRecurring: true, createdAt: new Date(now - DAY) });
      await pay(t.db, u.id, { amount: 999, providerId: PaymentProvider.GIFT });
      await pay(t.db, u.id, { amount: 300, status: PaymentStatus.REFUNDED });
      await pay(t.db, (await user(null)).id, { amount: 400 }); // no code: not attributed

      const rows = (await repo.paymentsByCode()).filter((r) => r.code === c);
      expect(rows.map((r) => [r.amount, r.isPurchase])).toEqual([
        [100, true],
        [200, false],
      ]); // oldest first
      expect(rows.every((r) => r.currency === 'RUB')).toBe(true);
    });
  });

  describe('registry', () => {
    it('getByCode and newest first', async () => {
      const older = await repo.create({ code: code(), createdAt: new Date(Date.now() - DAY) });
      const newer = await repo.create({ code: code(), channel: 'post' });

      expect((await repo.getByCode(newer.code))?.id).toBe(newer.id);
      expect(await repo.getByCode(code())).toBeNull();
      const ids = (await repo.listAll()).map((link) => link.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect([newer.isArchived, newer.alertsSent]).toEqual([false, []]);
      expect((await repo.getById(older.id))?.code).toBe(older.code);
    });
  });
});
