/** The bot exactly as `main.ts` builds it: every composer in its real order, on a real database. */
import { eq } from 'drizzle-orm';
import { type Bot, MemorySessionStorage } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../config';
import { createDb, type DbClient } from '../db/client';
import { subscriptions, users } from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { FakeBot } from '../testing/fakes/bot';
import { FakeProducer } from '../testing/fakes/producer';
import { FakeQueue } from '../testing/fakes/queue';
import { FakeRedis } from '../testing/fakes/redis';
import type { BotContext, BotSession } from './context';
import { createComposers } from './handlers';
import { setupBot } from './setup';
import { messageUpdate, tgUser } from './test-utils';

const OWNER = 7_100_001;
const owner = tgUser({ id: OWNER, username: 'owner' });
const ownerIds = settings.rbac.ownerIds as number[];

let database: TestDatabase;
let db: DbClient;
let fake: FakeBot;
let bot: Bot<BotContext>;

const sentTexts = () => fake.sent('sendMessage').map((call) => call.payload.text as string);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.config);
  fake = new FakeBot();
  bot = setupBot(fake.bot as unknown as Bot<BotContext>, {
    db: db.db,
    clients: { producer: new FakeProducer(), redis: new FakeRedis(), queue: new FakeQueue() },
    storage: new MemorySessionStorage<BotSession>(),
    composers: createComposers(),
  });
  ownerIds.push(OWNER);
  await bot.handleUpdate(messageUpdate('/start', owner));
});

afterAll(async () => {
  ownerIds.splice(ownerIds.indexOf(OWNER), 1);
  await db.close();
  await database.drop();
});

beforeEach(() => fake.clear());

describe('the bot as it runs', () => {
  it('/start reaches the start composer through the auth and link ones', async () => {
    await bot.handleUpdate(messageUpdate('/start', tgUser({ id: 7_100_002, username: 'plain' })));

    expect(sentTexts()).toHaveLength(1);
    expect(await db.db.select().from(users).where(eq(users.telegramId, 7_100_002))).toHaveLength(1);
  });

  it('/start with an expired login token is handled by the auth composer, not the menu', async () => {
    await bot.handleUpdate(messageUpdate('/start auth_expired', tgUser({ id: 7_100_003, username: 'expired' })));

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).not.toContain('шаблонный бот');
  });

  it('/stats sends the digest so far to the owner who asked, and to nobody else', async () => {
    await bot.handleUpdate(messageUpdate('/stats', owner));

    const calls = fake.sent('sendRichMessage');
    expect(calls.map((call) => call.payload.chat_id)).toEqual([OWNER]);
    expect(JSON.stringify(calls[0]?.payload)).toContain('📊');
    expect(fake.sent('sendMessage')).toEqual([]);
  });

  it('/stats falls back to HTML when Telegram refuses the rich message', async () => {
    fake.failNext('sendRichMessage', { error_code: 400, description: 'Bad Request: rich message' });

    await bot.handleUpdate(messageUpdate('/stats', owner));

    expect(sentTexts()[0]).toContain('📊');
  });

  it('/stats is for owners', async () => {
    await bot.handleUpdate(messageUpdate('/stats', tgUser({ id: 7_100_004, username: 'nosy' })));

    expect(fake.sent('sendRichMessage')).toEqual([]);
    expect(sentTexts().some((text) => text.includes('📊'))).toBe(false);
  });

  describe('/giftsub', () => {
    const TARGET = 7_100_005;
    const target = tgUser({ id: TARGET, username: 'gifted' });
    const subscriptionsOf = async () => {
      const [row] = await db.db.select().from(users).where(eq(users.telegramId, TARGET));
      if (!row) throw new Error('no user');
      return { user: row, rows: await db.db.select().from(subscriptions).where(eq(subscriptions.userId, row.id)) };
    };

    it('creates a subscription, then extends it', async () => {
      await bot.handleUpdate(messageUpdate('/start', target));
      fake.clear();

      await bot.handleUpdate(messageUpdate(`/giftsub ${TARGET} week`, owner));

      const first = await subscriptionsOf();
      expect(sentTexts()[0]).toContain('✅ Successfully gifted week subscription to user @gifted');
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toMatchObject({ productId: 'GIFT_SUB', providerId: 'GIFT', status: 'ACTIVE' });
      expect(first.user.isOnboarded).toBe(true);
      const firstEnd = first.rows[0]?.endDate.getTime() ?? 0;
      const week = 7 * 24 * 3600 * 1000;
      expect(firstEnd).toBeGreaterThan(Date.now() + week - 60_000);
      expect(firstEnd).toBeLessThanOrEqual(Date.now() + week);

      await bot.handleUpdate(messageUpdate(`/giftsub ${TARGET} week`, owner));

      const second = await subscriptionsOf();
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]?.endDate.getTime()).toBe(firstEnd + week);
    });
  });
});
