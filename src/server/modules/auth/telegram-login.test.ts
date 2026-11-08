/** Telegram code login, deep link login and logout. The Python app has no tests for these; see `auth_telegram.py`. */
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../../bot/context';
import { databaseMiddleware, servicesMiddleware } from '../../bot/middlewares';
import { callbackUpdate, messageUpdate } from '../../bot/test-utils';
import { settings } from '../../config';
import { users } from '../../db/schema';
import { Services } from '../../services';
import { createTestApp, createUser, nextTelegramId, type TestApp } from '../../testing';
import { authComposer } from './bot';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
const json = async (res: Response): Promise<any> => res.json();

const COOKIE = settings.session.cookieName;
const HANDLED_BY_NEXT = 'next composer';

let t: TestApp;
let bot: Bot<BotContext>;

beforeAll(async () => {
  t = await createTestApp();
  bot = t.fakes.bot.bot as unknown as Bot<BotContext>;
  const { queue, redis, producer } = t.fakes;
  bot.use(databaseMiddleware(t.db), servicesMiddleware(Services, { bot, producer, redis, queue }));
  bot.use(authComposer);
  bot.on('message', (ctx) => ctx.reply(HANDLED_BY_NEXT));
});
afterAll(() => t.close());

beforeEach(() => {
  t.fakes.redis.clear();
  t.fakes.bot.clear();
});

const sessionFrom = (response: Response): string | undefined =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${COOKIE}=`))
    ?.split(';')[0]
    ?.slice(COOKIE.length + 1);

describe('code login', () => {
  const send = (username: string) => t.client.post('/auth/login/telegram/code/send', { username });
  const verify = (username: string, code: string) =>
    t.client.post('/auth/login/telegram/code/verify', { username, code });

  /** The code of the last message, the part inside `<code>`. */
  const sentCode = (): string => {
    const text = String(t.fakes.bot.sent('sendMessage').at(-1)?.payload.text);
    return /<code>(\d{6})<\/code>/.exec(text)?.[1] ?? '';
  };

  it('sends the code over Telegram, and verifying it logs in', async () => {
    const user = await createUser(t.db, { tgUsername: 'ann_tg' });

    const sent = await send('@ANN_tg');

    expect(sent.status).toBe(200);
    expect(await json(sent)).toEqual({ message: 'Verification code sent to your Telegram', expires_in: 300 });
    const [message] = t.fakes.bot.sent('sendMessage');
    expect(message?.payload).toMatchObject({ chat_id: user.telegramId, parse_mode: 'HTML' });

    const verified = await verify('ann_tg', sentCode());

    expect(verified.status).toBe(200);
    const body = await json(verified);
    expect(body.message).toBe('Successfully logged in');
    expect(body.user).toMatchObject({ id: user.id, tg_username: 'ann_tg', user_type: 'REGISTERED' });
    expect(body.user).not.toHaveProperty('password_hash');

    const me = await t.client.get('/users/me', { headers: { cookie: `${COOKIE}=${sessionFrom(verified)}` } });
    expect((await json(me)).id).toBe(user.id);
  });

  it('a code works once', async () => {
    await createUser(t.db, { tgUsername: 'once_tg' });
    await send('once_tg');
    const code = sentCode();

    expect((await verify('once_tg', code)).status).toBe(200);
    expect((await verify('once_tg', code)).status).toBe(400);
  });

  it('an unknown username is a 404', async () => {
    const response = await send('nobody_tg');
    expect(response.status).toBe(404);
    expect((await json(response)).detail).toContain('Username not found');
  });

  it('too many requests are a 429', async () => {
    await createUser(t.db, { tgUsername: 'busy_tg' });
    for (let attempt = 0; attempt < 5; attempt++) expect((await send('busy_tg')).status).toBe(200);

    expect((await send('busy_tg')).status).toBe(429);
  });

  it('a failed Telegram send still answers 200, as Python does', async () => {
    await createUser(t.db, { tgUsername: 'blocked_tg' });
    t.fakes.bot.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    expect((await send('blocked_tg')).status).toBe(200);
  });

  it.each([
    ['a wrong format', 'abc', 'Invalid code format'],
    ['no code requested', '123456', 'expired or not found'],
  ])('%s is a 400', async (_name, code, detail) => {
    const response = await verify('anyone_tg', code);
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain(detail);
  });

  it('a wrong code is a 400, and the right one still works', async () => {
    await createUser(t.db, { tgUsername: 'typo_tg' });
    await send('typo_tg');
    const code = sentCode();

    const wrong = await verify('typo_tg', code === '000000' ? '000001' : '000000');
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).detail).toContain('Invalid verification code');
    expect((await verify('typo_tg', code)).status).toBe(200);
  });

  it('a stored code past its expiry is a 400 and gone', async () => {
    const user = await createUser(t.db, { tgUsername: 'late_tg' });
    await t.fakes.redis.set(
      'auth_code:late_tg',
      JSON.stringify({ code: '123456', user_id: user.id, expires_at: '2020-01-01T00:00:00.000000+00:00' }),
    );

    const response = await verify('late_tg', '123456');

    expect(response.status).toBe(400);
    expect(await t.fakes.redis.get('auth_code:late_tg')).toBeNull();
  });

  it('too many attempts are a 429', async () => {
    for (let attempt = 0; attempt < 10; attempt++) expect((await verify('guess_tg', '123456')).status).toBe(400);
    expect((await verify('guess_tg', '123456')).status).toBe(429);
  });

  it('concurrent guesses each count: a burst gets no more than the cap, and then the right code is refused', async () => {
    // Every request reads before any of them writes: Python's get-check-set let each one read the same count
    await createUser(t.db, { tgUsername: 'burst_tg' });
    await send('burst_tg');
    const code = sentCode();
    const wrong = code === '000000' ? '000001' : '000000';
    const redis = t.fakes.redis;
    const read = redis.get.bind(redis);
    const slowRead = vi.spyOn(redis, 'get').mockImplementation(async (key) => {
      const value = await read(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return value;
    });

    const responses = await Promise.all(Array.from({ length: 30 }, () => verify('burst_tg', wrong))).finally(() =>
      slowRead.mockRestore(),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 400)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(20);
    expect((await verify('burst_tg', code)).status).toBe(429);
  });

  it('concurrent sends each count too', async () => {
    await createUser(t.db, { tgUsername: 'spam_tg' });
    const redis = t.fakes.redis;
    const read = redis.get.bind(redis);
    const slowRead = vi.spyOn(redis, 'get').mockImplementation(async (key) => {
      const value = await read(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return value;
    });

    const responses = await Promise.all(Array.from({ length: 12 }, () => send('spam_tg'))).finally(() =>
      slowRead.mockRestore(),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(t.fakes.bot.sent('sendMessage')).toHaveLength(5);
  });

  it('a code of a user deleted since it was sent is a 404', async () => {
    await t.fakes.redis.set(
      'auth_code:gone_tg',
      JSON.stringify({
        code: '123456',
        user_id: '0195d3a2-0000-7000-8000-000000000000',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect((await verify('gone_tg', '123456')).status).toBe(404);
  });

  it('a body without a username is a 422', async () => {
    expect((await t.client.post('/auth/login/telegram/code/send', {})).status).toBe(422);
  });
});

describe('deep link login', () => {
  const start = async (): Promise<string> => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start');
    expect(response.status).toBe(200);
    return (await json(response)).token;
  };
  const poll = (token: string) => t.client.get(`/auth/login/telegram/deeplink/poll?token=${token}`);

  let updateId = 0;
  const startCommand = (args: string, from: { id: number; first_name: string; username?: string }): Update => {
    const text = `/start ${args}`;
    return {
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        from: { ...from, is_bot: false },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
      },
    };
  };
  const replies = () => t.fakes.bot.sent('sendMessage').map((call) => String(call.payload.text));
  const confirm = (token: string, from: { id: number; first_name: string; username?: string }) =>
    bot.handleUpdate(callbackUpdate(`auth_ok:${token}`, { ...from, is_bot: false }));

  it('start answers with the bot link', async () => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start');
    const body = await json(response);

    expect(body).toEqual({
      token: expect.any(String),
      bot_url: `https://t.me/test_bot?start=auth_${body.token}`,
      expires_in: 300,
    });
    expect(body.token).toHaveLength(43);
  });

  const recordedIp = async (headers: Record<string, string>): Promise<string> => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start', undefined, { headers });
    const { token } = await json(response);
    return JSON.parse((await t.fakes.redis.get(`web_auth:${token}`)) ?? '').ip;
  };

  it('records the client IP the proxy saw: X-Real-IP, not a forwarded hop the client wrote', async () => {
    // nginx: X-Real-IP $remote_addr, X-Forwarded-For $proxy_add_x_forwarded_for (the client's header, then the peer)
    expect(await recordedIp({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'x-real-ip': '203.0.113.7' })).toBe(
      '203.0.113.7',
    );
  });

  it('without X-Real-IP, the last forwarded hop: the one the proxy appended', async () => {
    expect(await recordedIp({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('without either header the address is unknown', async () => {
    expect(await recordedIp({})).toBe('unknown');
  });

  it('a forged first hop never reaches the confirmation', async () => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start', undefined, {
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'x-real-ip': '203.0.113.7' },
    });
    const { token } = await json(response);

    await bot.handleUpdate(startCommand(`auth_${token}`, { id: nextTelegramId(), first_name: 'Ann' }));

    expect(replies()[0]).toContain('requested from 203.0.113.7 at');
    expect(replies()[0]).not.toContain('198.51.100.1');
  });

  it('a pending token polls as pending', async () => {
    const response = await poll(await start());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'pending', user_id: null });
  });

  it('an unknown token is a 410', async () => {
    const response = await poll('nope');
    expect(response.status).toBe(410);
    expect(await json(response)).toEqual({ detail: 'Token expired or invalid' });
  });

  it('a poll without a token is a 422', async () => {
    const response = await t.client.get('/auth/login/telegram/deeplink/poll');
    expect(response.status).toBe(422);
    expect((await json(response)).detail[0].loc).toEqual(['query', 'token']);
  });

  it('opening the link logs nobody in: the bot asks first, and says where the login came from', async () => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start', undefined, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    const { token } = await json(response);
    const telegramId = nextTelegramId();

    await bot.handleUpdate(startCommand(`auth_${token}`, { id: telegramId, first_name: 'Ann' }));

    const [message] = t.fakes.bot.sent('sendMessage');
    expect(String(message?.payload.text)).toMatch(
      /^Log in to the website with this Telegram account\?\n\nThe login was requested from 203\.0\.113\.7 at \d\d:\d\d UTC\./,
    );
    expect(message?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Log in', callback_data: `auth_ok:${token}` }]],
    });
    expect(await json(await poll(token))).toEqual({ status: 'pending', user_id: null });
    expect(t.fakes.bot.sent('sendMessage')).toHaveLength(1);
  });

  it('an address that is not an IP is not shown: the client sets the header', async () => {
    const response = await t.client.post('/auth/login/telegram/deeplink/start', undefined, {
      headers: { 'x-forwarded-for': 'your friend <b>Ann</b>' },
    });
    const { token } = await json(response);

    await bot.handleUpdate(startCommand(`auth_${token}`, { id: nextTelegramId(), first_name: 'Ann' }));

    expect(replies()[0]).toContain('requested from an unknown address at');
    expect(replies()[0]).not.toContain('Ann</b>');
  });

  it('the button verifies the token, the next poll logs the browser in, once', async () => {
    const token = await start();
    const from = { id: nextTelegramId(), first_name: 'Ann', username: 'ann_link' };
    await bot.handleUpdate(startCommand(`auth_${token}`, from));
    t.fakes.bot.clear();

    await confirm(token, from);

    expect(t.fakes.bot.sent('answerCallbackQuery')).toHaveLength(1);
    expect(replies()).toEqual([
      'Login successful!\n\nYou can now return to the website. Your session has been activated.',
    ]);
    const [row] = await t.db.select().from(users).where(eq(users.telegramId, from.id));
    expect(row).toMatchObject({ displayName: 'Ann', tgUsername: 'ann_link', userType: 'REGISTERED' });

    const response = await poll(token);
    expect(await json(response)).toEqual({ status: 'verified', user_id: row?.id });

    const session = sessionFrom(response);
    const me = await t.client.get('/users/me', { headers: { cookie: `${COOKIE}=${session}` } });
    expect((await json(me)).id).toBe(row?.id);

    expect((await poll(token)).status).toBe(410);
  });

  it('in a group the link gets no button and no reply, and goes no further', async () => {
    // A group member would press the button, and the session built from the presser would go to whoever polls
    const token = await start();
    const from = { id: nextTelegramId(), first_name: 'Mallory', is_bot: false };

    await bot.handleUpdate(messageUpdate(`/start auth_${token}`, from, 'supergroup'));
    await bot.handleUpdate(messageUpdate(`/start@test_bot auth_${token}`, from, 'supergroup'));

    expect(t.fakes.bot.sent('sendMessage')).toEqual([]);
    expect(await json(await poll(token))).toEqual({ status: 'pending', user_id: null });
  });

  it('the button of someone else is refused: nobody logs in as the presser', async () => {
    const token = await start();
    const opener = { id: nextTelegramId(), first_name: 'Mallory' };
    const presser = { id: nextTelegramId(), first_name: 'Ann' };
    await bot.handleUpdate(startCommand(`auth_${token}`, opener));
    t.fakes.bot.clear();

    await confirm(token, presser);

    expect(replies()).toEqual(['This login button is not for you.\n\nOpen the login link from the website yourself.']);
    expect(await t.db.select().from(users).where(eq(users.telegramId, presser.id))).toEqual([]);
    expect(await json(await poll(token))).toEqual({ status: 'pending', user_id: null });
  });

  it('a button nobody opened the link for is refused', async () => {
    const token = await start();

    await confirm(token, { id: nextTelegramId(), first_name: 'Ann' });

    expect(replies()[0]).toContain('not for you');
    expect(await json(await poll(token))).toEqual({ status: 'pending', user_id: null });
  });

  it('a button pressed outside a private chat is refused, even by who opened the link', async () => {
    const token = await start();
    const from = { id: nextTelegramId(), first_name: 'Ann', is_bot: false };
    await bot.handleUpdate(startCommand(`auth_${token}`, from));
    const update = callbackUpdate(`auth_ok:${token}`, from);
    // biome-ignore lint/style/noNonNullAssertion: built just above
    (update.callback_query!.message as { chat: unknown }).chat = { id: -100, type: 'supergroup', title: 'G' };

    await bot.handleUpdate(update);

    expect(await json(await poll(token))).toEqual({ status: 'pending', user_id: null });
  });

  it('a used link says so, on opening it and on the button', async () => {
    const token = await start();
    const from = { id: nextTelegramId(), first_name: 'Ann' };
    await bot.handleUpdate(startCommand(`auth_${token}`, from));
    await confirm(token, from);
    t.fakes.bot.clear();

    await bot.handleUpdate(startCommand(`auth_${token}`, from));
    await confirm(token, from);

    expect(replies()).toHaveLength(2);
    for (const reply of replies()) expect(reply).toContain('already been used');
  });

  it('a button of an expired link says so', async () => {
    await confirm('gone', { id: nextTelegramId(), first_name: 'Ann' });
    expect(replies()[0]).toContain('expired');
  });

  it('an expired link says so', async () => {
    await bot.handleUpdate(startCommand('auth_gone', { id: nextTelegramId(), first_name: 'Ann' }));
    expect(replies()[0]).toContain('expired');
  });

  it('a link with no token is invalid', async () => {
    await bot.handleUpdate(startCommand('auth_', { id: nextTelegramId(), first_name: 'Ann' }));
    expect(replies()).toEqual(['Invalid authentication link.']);
  });

  it('any other /start goes on to the next composer', async () => {
    await bot.handleUpdate(startCommand('r-123', { id: nextTelegramId(), first_name: 'Ann' }));
    expect(replies()).toEqual([HANDLED_BY_NEXT]);
  });

  it('a token with a corrupted state is a 500', async () => {
    await t.fakes.redis.set('web_auth:broken', JSON.stringify({ status: 'verified' }));
    const response = await poll('broken');
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ detail: 'Auth state corrupted' });
  });

  it('a token with an unknown status is a 500', async () => {
    await t.fakes.redis.set('web_auth:odd', JSON.stringify({ status: 'odd' }));
    expect((await poll('odd')).status).toBe(500);
  });
});

describe('logout', () => {
  const logout = (headers: Record<string, string> = {}) => t.client.post('/auth/logout', undefined, { headers });

  it('destroys the session and clears the cookie', async () => {
    const user = await createUser(t.db);
    const id = 'to-destroy';
    const key = `${settings.session.keyPrefix}${id}`;
    await t.fakes.redis.set(key, JSON.stringify({ user_id: user.id }));

    const response = await logout({ cookie: `${COOKIE}=${id}` });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ message: 'Successfully logged out' });
    expect(await t.fakes.redis.get(key)).toBeNull();

    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toContain(`${COOKIE}=`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
  });

  it('without a session it still answers 200', async () => {
    expect((await logout()).status).toBe(200);
  });
});
