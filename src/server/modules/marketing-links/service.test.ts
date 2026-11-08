/**
 * Port of core's `tests/integration/test_marketing_links_service.py`: the service on the aggregator, with the app's
 * config as a value of `Services` (no global state to restore). Links come through the `linkBases` seam.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminAuditLogs, type User, UserRole } from '../../db/schema';
import { MarketingCodeNotAllowedException, MarketingLinkNotFoundException } from '../../lib/errors';
import { createTestApp, createUser, type TestApp, TestServices } from '../../testing';
import { pay, servicesFor, uniq } from '../analytics/test-support';
import { MarketingLinksRepo } from './repo';
import type { MarketingLinkItem } from './schemas';
import { type MarketingLinksConfig, MarketingLinksService } from './service';

const APP_URL = 'https://t.me/test_bot/app';
const BOT_URL = 'https://t.me/test_bot';
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const dateOnlyAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

const servicesClass = (config: MarketingLinksConfig | null) =>
  class extends TestServices {
    override readonly internalReferalIds: ReadonlySet<string> = new Set(['ownlink']);
    override readonly marketingLinksConfig = config;
  };

describe('MarketingLinksService', () => {
  let t: TestApp;
  let actor: User;

  beforeAll(async () => {
    vi.spyOn(
      MarketingLinksService.prototype as unknown as { linkBases(): [string, string] },
      'linkBases',
    ).mockReturnValue([APP_URL, BOT_URL]);
    t = await createTestApp();
    actor = await createUser(t.db, { role: UserRole.ADMIN });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });
  afterEach(() => vi.clearAllMocks());

  const services = (config: MarketingLinksConfig | null = null) => servicesFor(t, servicesClass(config));
  const code = () => uniq('t');
  const user = (referralCode: string, extra: Parameters<typeof createUser>[1] = {}) =>
    createUser(t.db, { referralCode, ...extra });
  const audit = (action: string, targetId: string) =>
    t.db
      .select()
      .from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, action), eq(adminAuditLogs.targetId, targetId)));
  const itemOf = async (s: ReturnType<typeof services>, c: string): Promise<MarketingLinkItem> => {
    const found = (await s.marketingLinks.listLinks()).find((i) => i.code === c);
    if (!found) throw new Error(`${c} not listed`);
    return found;
  };
  const alertsOf = async (s: ReturnType<typeof services>, linkId: number) =>
    Object.fromEntries(
      (await s.marketingLinks.pendingAlerts()).filter((a) => a.linkId === linkId).map((a) => [a.key, a.text]),
    );

  describe('create and update', () => {
    it('create builds both links and audits', async () => {
      const s = services();
      const c = code();
      const item = await s.marketingLinks.create(actor, { code: c, channel: ' Post 1 ' });
      expect([item.registered, item.channel]).toEqual([true, 'Post 1']);
      expect(item.appLink).toBe(`${APP_URL}?startapp=r-${c}`);
      expect(item.botLink).toBe(`${BOT_URL}?start=${c}`);
      const rows = await audit('marketing_link_create', c);
      expect(rows).toHaveLength(1);
      expect([rows[0]?.targetType, rows[0]?.detail]).toEqual(['marketing_link', { channel: 'Post 1' }]);
      const link = await new MarketingLinksRepo(t.db).getByCode(c);
      expect(link?.createdBy).toBe(actor.username);
    });

    it("the app's own codes are not registrable", async () => {
      await expect(services().marketingLinks.create(actor, { code: 'ownlink' })).rejects.toThrow(
        /app's own notifications/,
      );
    });

    it('a duplicate code throws', async () => {
      const s = services();
      const c = code();
      await s.marketingLinks.create(actor, { code: c });
      await expect(s.marketingLinks.create(actor, { code: c })).rejects.toBeInstanceOf(
        MarketingCodeNotAllowedException,
      );
      await expect(s.marketingLinks.create(actor, { code: c })).rejects.toThrow(/already registered/);
    });

    it('a concurrent duplicate throws the same error and keeps the transaction', async () => {
      // Two requests both pass the lookup; the second insert hits the unique constraint. The savepoint keeps the
      // transaction usable and the error is the domain one (400, not 500).
      const c = code();
      const second = services();
      await second.marketingLinks.create(actor, { code: c });
      await t.db.transaction(async (tx) => {
        const { Repos } = await import('../../repos');
        const inTx = new (servicesClass(null))(
          new Repos(tx),
          t.fakes.producer,
          t.fakes.bot.bot,
          t.fakes.redis,
          t.fakes.queue,
        );
        const lookup = vi.spyOn(MarketingLinksRepo.prototype, 'getByCode').mockResolvedValue(null);
        await expect(inTx.marketingLinks.create(actor, { code: c })).rejects.toThrow(/already registered/);
        lookup.mockRestore();
        // the transaction still works after the failed insert
        expect(await tx.select().from(adminAuditLogs).where(eq(adminAuditLogs.targetId, c))).toHaveLength(1);
      });
    });

    it('updating an unknown link throws', async () => {
      const call = services().marketingLinks.update(actor, 2_147_483_000, { channel: 'x' });
      await expect(call).rejects.toBeInstanceOf(MarketingLinkNotFoundException);
      await expect(call).rejects.toThrow('Marketing link not found');
    });

    it('update trims the channel and audits only the sent fields', async () => {
      const s = services();
      const c = code();
      const created = await s.marketingLinks.create(actor, { code: c, price_rub: 10 });
      const item = await s.marketingLinks.update(actor, created.id as number, { channel: '  ', is_archived: true });
      expect([item.channel, item.isArchived, item.priceRub]).toEqual([null, true, 10]);
      const rows = await audit('marketing_link_update', c);
      expect(rows[0]?.detail).toEqual({ channel: null, is_archived: true });
    });
  });

  describe('listing', () => {
    it("the app's own codes are not listed", async () => {
      const s = services();
      const external = code();
      await user(external);
      await user('ownlink');
      const codes = new Set((await s.marketingLinks.listLinks()).map((i) => i.code));
      expect(codes.has(external)).toBe(true);
      expect(codes.has('ownlink')).toBe(false);
    });

    it('rates come from the config', async () => {
      const s = services({ rubPerUnit: { RUB: 1, XTR: 2 } });
      const c = code();
      await pay(t.db, (await user(c)).id, { amount: 100, currency: 'XTR' });
      await pay(t.db, (await user(c)).id, { amount: 50, currency: 'USD' }); // no rate: 0
      expect((await itemOf(s, c)).stats.revenueRub).toBe(200);
    });

    it('default rates', async () => {
      const c = code();
      await pay(t.db, (await user(c)).id, { amount: 100, currency: 'XTR' });
      expect((await itemOf(services(), c)).stats.revenueRub).toBe(110);
    });

    it('activation comes from the config', async () => {
      const c = code();
      const payer = await user(c, { lastActivityDate: today() });
      await pay(t.db, payer.id, { amount: 100 });
      await user(c, { lastActivityDate: today() });

      expect((await itemOf(services(), c)).stats.activated).toBe(2); // both opened the app

      const paid = { activation: () => sql`select user_id, created_at as at from payments` };
      expect((await itemOf(services(paid), c)).stats.activated).toBe(1);
    });
  });

  describe('alerts', () => {
    it('first user and first payment alert once', async () => {
      const s = services();
      const c = code();
      const link = await s.marketingLinks.create(actor, { code: c });
      await pay(t.db, (await user(c)).id, { amount: 100 });

      const alerts = await alertsOf(s, link.id as number);
      expect(new Set(Object.keys(alerts))).toEqual(new Set(['first_user', 'first_payment']));
      expect(alerts.first_user).toContain(c);
      expect(alerts.first_user).toContain('#code_');

      await s.marketingLinks.markAlertsSent(await s.marketingLinks.pendingAlerts());
      expect(await alertsOf(s, link.id as number)).toEqual({});
    });

    it('registering an old code does not replay its history', async () => {
      const s = services();
      const c = code();
      await user(c, { createdAt: daysAgo(90) });
      const link = await s.marketingLinks.create(actor, { code: c });
      expect(await alertsOf(s, link.id as number)).toEqual({});
    });

    it('archived links get no alerts', async () => {
      const s = services();
      const c = code();
      const link = await s.marketingLinks.create(actor, { code: c });
      await s.marketingLinks.update(actor, link.id as number, { is_archived: true });
      await user(c);
      expect(await alertsOf(s, link.id as number)).toEqual({});
    });

    it('digests on days after the post', async () => {
      const s = services();
      const weekOld = await s.marketingLinks.create(actor, {
        code: code(),
        price_rub: 1000,
        published_on: dateOnlyAgo(7),
      });
      const dayOld = await s.marketingLinks.create(actor, { code: code(), published_on: dateOnlyAgo(1) });

      const weekAlerts = await alertsOf(s, weekOld.id as number);
      expect(Object.keys(weekAlerts)).toEqual(['day_7']); // day 1 has passed unsent: no late digests
      expect(weekAlerts.day_7).toContain('Day 7');
      expect(weekAlerts.day_7).toContain('not yet');
      const dayAlerts = await alertsOf(s, dayOld.id as number);
      expect(Object.keys(dayAlerts)).toEqual(['day_1']);
      expect(dayAlerts.day_1).toContain('Nobody came');
      expect(dayAlerts.day_1).toContain('opened the app'); // the default activation label
    });

    it("the digest uses the app's activation label", async () => {
      const s = services({ activationLabel: 'did <X>' });
      const c = code();
      const link = await s.marketingLinks.create(actor, { code: c, published_on: dateOnlyAgo(1) });
      await user(c, { lastActivityDate: today() });
      const digest = (await alertsOf(s, link.id as number)).day_1;
      expect(digest).toContain('1 users · 100% did &lt;X&gt; · 0 paid (0%)');
    });
  });
});
