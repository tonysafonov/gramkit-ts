import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { MemorySessionStorage } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../config';
import { createDb, type DbClient } from '../db/client';
import { users } from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { FakeBot } from '../testing/fakes/bot';
import { FakeProducer } from '../testing/fakes/producer';
import { FakeQueue } from '../testing/fakes/queue';
import { FakeRedis } from '../testing/fakes/redis';
import type { BotContext, BotSession } from './context';
import { coreAdminComposer } from './handlers/admin';
import { appAdminComposer } from './handlers/app-admin';
import { createStartComposer } from './handlers/start';
import { setupBot } from './setup';
import { callbackUpdate, messageUpdate, myChatMemberUpdate, tgUser } from './test-utils';

// The whole chain on a real database: Database → Services → Auth → I18n → FSM session → composers.

const OWNER = 7_000_001;
let database: TestDatabase;
let db: DbClient;
let fake: FakeBot;
let queue: FakeQueue;
let bot: Bot<BotContext>;
const ownerIds = settings.rbac.ownerIds as number[];

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.config);
  fake = new FakeBot();
  queue = new FakeQueue();
  bot = setupBot(fake.bot as unknown as Bot<BotContext>, {
    db: db.db,
    clients: { producer: new FakeProducer(), redis: new FakeRedis(), queue },
    storage: new MemorySessionStorage<BotSession>(),
    composers: [
      createStartComposer(
        { menuI18nKey: 'app.menu', posthogEvent: 'bot_command_start' },
        { botUrl: 'https://t.me/mybot' },
      ),
      appAdminComposer,
      coreAdminComposer,
    ],
  });
  ownerIds.push(OWNER);
});

afterAll(async () => {
  ownerIds.splice(ownerIds.indexOf(OWNER), 1);
  await db.close();
  await database.drop();
});

// Usernames are unique in the database
const member = (id: number) => tgUser({ id, username: `u${id}` });
const texts = () => fake.sent('sendMessage').map((call) => call.payload.text as string);

describe('bot', () => {
  it('/start creates the user and sends the menu in their language', async () => {
    fake.clear();
    await bot.handleUpdate(messageUpdate('/start', tgUser({ id: 501, username: 'ann', language_code: 'ru' })));

    const [row] = await db.db.select().from(users).where(eq(users.telegramId, 501));
    expect(row?.username).toBe('ann');
    expect(texts()).toEqual(['Привет! Я шаблонный бот. Вы можете настроить меня под свои нужды.']);
  });

  it('a membership update creates no user', async () => {
    await bot.handleUpdate(myChatMemberUpdate(member(502)));

    const rows = await db.db.select().from(users).where(eq(users.telegramId, 502));
    expect(rows).toHaveLength(0);
  });

  it('a throwing handler rolls the update back and the bot goes on', async () => {
    fake.clear();
    // The menu fails on a bad key set by nothing here, so fail the send instead: the user row is still rolled back
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: boom' });
    await expect(bot.handleUpdate(messageUpdate('/start', member(503)))).rejects.toThrow('boom');

    expect(await db.db.select().from(users).where(eq(users.telegramId, 503))).toHaveLength(0);
    await bot.handleUpdate(messageUpdate('/start', member(503)));
    expect(await db.db.select().from(users).where(eq(users.telegramId, 503))).toHaveLength(1);
  });

  it('refuses /admin to a user who is not an owner', async () => {
    fake.clear();
    await bot.handleUpdate(messageUpdate('/admin', member(504)));
    expect(texts()).toEqual(["You don't have permission to use this command"]);
  });

  it('refuses /backup to a user who is not an owner, and queues nothing', async () => {
    fake.clear();
    await bot.handleUpdate(messageUpdate('/backup', member(504)));
    expect(texts()).toEqual(["You don't have permission to use this command"]);
    expect(queue.jobs).toHaveLength(0);
  });

  it('/backup queues the job for an owner', async () => {
    fake.clear();
    await bot.handleUpdate(messageUpdate('/backup', member(OWNER)));
    expect(queue.jobs).toEqual([
      { jobName: 'backup_database_job', payload: { requester_telegram_id: OWNER }, options: {} },
    ]);
    expect(texts()).toEqual([
      '⏳ Creating database backup...',
      "✅ Backup job queued! You'll receive the file shortly.",
    ]);
  });

  it('/admin lists the commands for an owner, as Markdown', async () => {
    fake.clear();
    await bot.handleUpdate(messageUpdate('/admin', member(OWNER)));
    const [call] = fake.sent('sendMessage');
    expect(call?.payload.parse_mode).toBe('Markdown');
    expect(call?.payload.text).toContain('/giftsub <user\\_id>');
  });

  it('/giftsub validates its arguments', async () => {
    fake.clear();
    const owner = member(OWNER);
    await bot.handleUpdate(messageUpdate('/giftsub', owner));
    await bot.handleUpdate(messageUpdate('/giftsub 1', owner));
    await bot.handleUpdate(messageUpdate('/giftsub 1 decade', owner));
    await bot.handleUpdate(messageUpdate('/giftsub abc week', owner));
    await bot.handleUpdate(messageUpdate('/giftsub 999999999 week', owner));
    expect(texts()).toEqual([
      'Usage: /giftsub &lt;user_id&gt; &lt;week|month|year|max&gt;',
      'Invalid arguments. Usage: /giftsub &lt;user_id&gt; &lt;week|month|year|max&gt;',
      'Invalid duration. Use week, month, year, or max',
      'Invalid Telegram ID. Please provide a numeric Telegram ID',
      'User with Telegram ID 999999999 not found',
    ]);
  });

  it('/broadcast walks the flow and queues the job on confirmation', async () => {
    fake.clear();
    queue.jobs.length = 0;
    const owner = member(OWNER);

    await bot.handleUpdate(messageUpdate('/broadcast', owner));
    await bot.handleUpdate(messageUpdate('Big news', owner));
    await bot.handleUpdate(callbackUpdate('keyboard_none', owner));
    expect(texts().at(-1)).toContain('Above is a preview of your broadcast message');
    expect(fake.sent('sendMessage').some((call) => call.payload.text === 'Big news')).toBe(true);

    await bot.handleUpdate(callbackUpdate('broadcast_confirm', owner));

    expect(queue.jobs).toHaveLength(1);
    const [job] = queue.jobs;
    expect(job?.jobName).toBe('user_broadcast_job');
    expect(job?.payload).toMatchObject({
      requester_telegram_id: OWNER,
      broadcast_data: { message_type: 'text', message_text: 'Big news', has_formatting: false, keyboard_type: 'none' },
    });
    const queued = job?.payload as unknown as { broadcast_data: { run_id: string } };
    expect(queued.broadcast_data.run_id).toMatch(/^[0-9a-f]{32}$/);

    // The flow is over: the next plain message is no broadcast
    fake.clear();
    await bot.handleUpdate(messageUpdate('hello', owner));
    expect(fake.calls).toHaveLength(0);
  });

  it('/broadcast cancel leaves the flow without queuing', async () => {
    queue.jobs.length = 0;
    const owner = member(OWNER);
    await bot.handleUpdate(messageUpdate('/broadcast', owner));
    await bot.handleUpdate(messageUpdate('Oops', owner));
    await bot.handleUpdate(callbackUpdate('keyboard_none', owner));
    await bot.handleUpdate(callbackUpdate('broadcast_cancel', owner));
    expect(texts().at(-1)).toBe('Broadcast cancelled.');
    await bot.handleUpdate(callbackUpdate('broadcast_confirm', owner));
    expect(queue.jobs).toHaveLength(0);
  });
});
