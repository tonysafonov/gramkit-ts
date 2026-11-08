/** Linking a Telegram account, routes and bot. The Python app has no tests for these; see `services/telegram_link.py`. */
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BotContext } from '../../bot/context';
import { databaseMiddleware, servicesMiddleware } from '../../bot/middlewares';
import { callbackUpdate, messageUpdate } from '../../bot/test-utils';
import { users } from '../../db/schema';
import { Services } from '../../services';
import { asUser, createTestApp, createUser, nextTelegramId, type TestApp } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import { telegramLinkComposer } from './bot';
import { RATE_LIMIT_MAX } from './service';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
const json = async (res: Response): Promise<any> => res.json();

const HANDLED_BY_NEXT = 'next composer';

let t: TestApp;
let bot: Bot<BotContext>;

beforeAll(async () => {
  t = await createTestApp();
  bot = t.fakes.bot.bot as unknown as Bot<BotContext>;
  const { queue, redis, producer } = t.fakes;
  bot.use(databaseMiddleware(t.db), servicesMiddleware(Services, { bot, producer, redis, queue }));
  bot.use(telegramLinkComposer);
  bot.on('message', (ctx) => ctx.reply(HANDLED_BY_NEXT));
});
afterAll(() => t.close());

beforeEach(() => {
  t.fakes.redis.clear();
  t.fakes.bot.clear();
});

const webUser = (overrides = {}) =>
  createUser(t.db, { telegramId: null, tgFirstName: null, tgUsername: null, ...overrides });

const start = (user: { id: string }) =>
  t.client.post('/auth/link/telegram/start', undefined, { headers: asUser(user) });

async function startedToken(user: { id: string }): Promise<string> {
  const response = await start(user);
  expect(response.status).toBe(200);
  return (await json(response)).link_token;
}

const poll = (user: { id: string }, token: string) =>
  t.client.get(`/auth/link/telegram/poll?token=${token}`, { headers: asUser(user) });

let updateId = 0;
function startCommand(args: string, from: Record<string, unknown> & { id: number }): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from.id, type: 'private', first_name: 'Ann' },
      from: { first_name: 'Ann', is_bot: false, ...from },
      text: `/start ${args}`,
      entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
    },
  };
}

const replies = () => t.fakes.bot.sent('sendMessage').map((call) => String(call.payload.text));

/** Open the link, then press its button, as the user does. */
async function openAndConfirm(token: string, from: Record<string, unknown> & { id: number }): Promise<void> {
  await bot.handleUpdate(startCommand(`link_${token}`, from));
  await bot.handleUpdate(callbackUpdate(`link_ok:${token}`, { first_name: 'Ann', is_bot: false, ...from } as never));
}

describe('POST /auth/link/telegram/start', () => {
  it('answers with a token and the bot link', async () => {
    const response = await start(await webUser());

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({
      link_token: expect.any(String),
      bot_url: `https://t.me/test_bot?start=link_${body.link_token}`,
      expires_in: 300,
    });
  });

  it('a user with Telegram linked gets a 409', async () => {
    const response = await start(await createUser(t.db));

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      detail: { error: 'already_linked', message: 'Telegram account already linked to this account.' },
    });
  });

  it('a logged-out visitor (the shared guest row) gets a 401, not a token for the row', async () => {
    const response = await t.client.post('/auth/link/telegram/start');

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ detail: { error: 'not_authenticated', message: 'Login required' } });
    const [guest] = await t.db.select().from(users).where(eq(users.id, MOCK_GUEST_USER_ID));
    expect(guest?.telegramId ?? null).toBeNull(); // the 401 rolls back the row it created, if any
  });

  it('too many starts are a 429', async () => {
    const user = await webUser();
    for (let attempt = 0; attempt < RATE_LIMIT_MAX; attempt++) await startedToken(user);

    const response = await start(user);
    expect(response.status).toBe(429);
    expect((await json(response)).detail.error).toBe('rate_limited');
  });
});

describe('GET /auth/link/telegram/poll', () => {
  it('a pending token', async () => {
    const user = await webUser();
    const response = await poll(user, await startedToken(user));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      status: 'pending',
      telegram_id: null,
      telegram_username: null,
      error: null,
    });
  });

  it('an unknown token is expired', async () => {
    const response = await poll(await webUser(), 'nope');
    expect(response.status).toBe(200);
    expect((await json(response)).status).toBe('expired');
  });

  it('a logged-out visitor gets a 401', async () => {
    const response = await t.client.get('/auth/link/telegram/poll?token=nope');
    expect(response.status).toBe(401);
  });

  it('no token is a 422', async () => {
    const response = await t.client.get('/auth/link/telegram/poll', { headers: asUser(await webUser()) });
    expect(response.status).toBe(422);
  });
});

describe('/start link_<token>', () => {
  it('opening the link links nothing: the bot asks first, naming the web account', async () => {
    const user = await webUser({ email: 'ann.lee@example.com' });
    const token = await startedToken(user);
    const telegramId = nextTelegramId();

    await bot.handleUpdate(startCommand(`link_${token}`, { id: telegramId }));

    const [message] = t.fakes.bot.sent('sendMessage');
    expect(String(message?.payload.text)).toMatch(/^Link this Telegram account to a\*\*\*@example\.com\?/);
    expect(message?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Link', callback_data: `link_ok:${token}` }]],
    });
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.telegramId).toBeNull();
    expect(await t.db.select().from(users).where(eq(users.telegramId, telegramId))).toEqual([]);
    expect(await json(await poll(user, token))).toMatchObject({ status: 'pending' });
  });

  it('names the account by username without an email, escaped', async () => {
    const user = await webUser({ email: null, username: 'a<b>' });
    const token = await startedToken(user);

    await bot.handleUpdate(startCommand(`link_${token}`, { id: nextTelegramId() }));

    expect(replies()[0]).toMatch(/^Link this Telegram account to @a&lt;b&gt;\?/);
  });

  it('the button links the account, and the web sees it', async () => {
    const user = await webUser({ displayName: 'Web name', languageCode: 'ru' });
    const token = await startedToken(user);
    const telegramId = nextTelegramId();

    await openAndConfirm(token, {
      id: telegramId,
      first_name: 'Ann',
      last_name: 'Lee',
      username: 'ann_tg',
      language_code: 'en',
      is_premium: true,
    });

    expect(t.fakes.bot.sent('answerCallbackQuery')).toHaveLength(1);
    expect(replies()[1]).toContain('Account linked successfully!');
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({
      telegramId,
      tgFirstName: 'Ann',
      tgLastName: 'Lee',
      tgUsername: 'ann_tg',
      tgLanguageCode: 'en',
      tgIsPremium: true,
      tgIsBot: false,
      displayName: 'Web name', // kept
      languageCode: 'ru', // kept
    });

    expect(await json(await poll(user, token))).toEqual({
      status: 'completed',
      telegram_id: telegramId,
      telegram_username: 'ann_tg',
      error: null,
    });
  });

  it('fills in an empty display name and language', async () => {
    const user = await webUser({ displayName: null, languageCode: null });
    const token = await startedToken(user);

    await openAndConfirm(token, { id: nextTelegramId(), language_code: 'ru' });

    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ displayName: 'Ann', languageCode: 'ru' });
  });

  it('a Telegram account of another user is refused, and the web is told', async () => {
    const other = await createUser(t.db);
    const user = await webUser();
    const token = await startedToken(user);

    await openAndConfirm(token, { id: other.telegramId as number });

    expect(replies()[1]).toContain('already linked to another account');
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.telegramId).toBeNull();
    expect(await json(await poll(user, token))).toMatchObject({ status: 'error', error: 'telegram_already_used' });
  });

  it('a used token is invalid', async () => {
    const user = await webUser();
    const token = await startedToken(user);
    const from = { id: nextTelegramId() };
    await openAndConfirm(token, from);
    t.fakes.bot.clear();

    await openAndConfirm(token, from);

    expect(replies()).toHaveLength(2);
    for (const reply of replies()) expect(reply).toContain('expired or is invalid');
  });

  it('an unknown token is invalid, on opening it and on the button', async () => {
    await openAndConfirm('nope', { id: nextTelegramId() });
    expect(replies()).toHaveLength(2);
    for (const reply of replies()) expect(reply).toContain('expired or is invalid');
  });

  it('no token is an invalid link', async () => {
    await bot.handleUpdate(startCommand('link_', { id: nextTelegramId() }));
    expect(replies()).toEqual(['Invalid link.']);
  });

  it('a token of a deleted user says the account is gone', async () => {
    await t.fakes.redis.set(
      'telegram_link:orphan',
      JSON.stringify({ user_id: '0195d3a2-0000-7000-8000-000000000000', status: 'pending' }),
    );

    await openAndConfirm('orphan', { id: nextTelegramId() });

    expect(replies()[0]).toMatch(/^Link this Telegram account to a web account\?/);
    expect(replies()[1]).toContain('Account not found');
    expect(await t.fakes.redis.get('telegram_link:orphan')).toBeNull();
  });

  it('in a group the link gets no button and no reply, and goes no further', async () => {
    // A group member would press the button and get their Telegram attached to whoever started the link
    const user = await webUser();
    const token = await startedToken(user);
    const from = { id: nextTelegramId(), first_name: 'Mallory', is_bot: false };

    await bot.handleUpdate(messageUpdate(`/start link_${token}`, from, 'supergroup'));
    await bot.handleUpdate(messageUpdate(`/start@test_bot link_${token}`, from, 'supergroup'));

    expect(t.fakes.bot.sent('sendMessage')).toEqual([]);
    expect(await json(await poll(user, token))).toMatchObject({ status: 'pending' });
  });

  it('the button of someone else is refused: their Telegram is not linked', async () => {
    const user = await webUser();
    const token = await startedToken(user);
    const opener = nextTelegramId();
    const presser = nextTelegramId();
    await bot.handleUpdate(startCommand(`link_${token}`, { id: opener }));
    t.fakes.bot.clear();

    await bot.handleUpdate(callbackUpdate(`link_ok:${token}`, { id: presser, first_name: 'Ann', is_bot: false }));

    expect(replies()).toEqual(['This button is not for you.\n\nOpen the link from the website yourself.']);
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.telegramId).toBeNull();
    expect(await json(await poll(user, token))).toMatchObject({ status: 'pending' });
  });

  it('a button nobody opened the link for is refused', async () => {
    const user = await webUser();
    const token = await startedToken(user);

    await bot.handleUpdate(
      callbackUpdate(`link_ok:${token}`, { id: nextTelegramId(), first_name: 'Ann', is_bot: false }),
    );

    expect(replies()[0]).toContain('not for you');
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.telegramId).toBeNull();
  });

  it('any other /start goes on to the next composer', async () => {
    await bot.handleUpdate(startCommand('r-123', { id: nextTelegramId() }));
    expect(replies()).toEqual([HANDLED_BY_NEXT]);
  });
});
