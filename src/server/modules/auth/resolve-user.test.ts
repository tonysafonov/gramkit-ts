/**
 * Port of `tests/unit/auth/test_resolve_user_errors.py`, plus the guest's locale and the debug login.
 *
 * Auth errors: an invalid initData is a 401, the infrastructure failing is a 503, never "not logged in".
 *
 * Regression (gramkit load test): DNS failures while opening a DB/Redis connection came back as 401 "Authentication
 * failed", so a traffic spike logged people out; on the session-cookie path the same failure silently turned a
 * logged-in web user into the shared guest.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getUser } from '../../auth/context';
import { settings } from '../../config';
import { users } from '../../db/schema';
import type { Env } from '../../env';
import { RETRY_AFTER_SECONDS } from '../../lib/errors';
import { getRequestContext } from '../../lib/request-context';
import { createTestApp, createUser, generateTelegramInitData, type TestApp } from '../../testing';
import { UsersService } from '../users/service';
import { getMockGuestUser, MOCK_GUEST_USER_ID } from './resolve-user';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
const json = async (res: Response): Promise<any> => res.json();

const routes = new Hono<Env>().get('/me', getUser, (c) =>
  c.json({ id: c.var.user.id, locale: getRequestContext()?.locale }),
);

const dnsError = () => Object.assign(new Error('getaddrinfo EAI_AGAIN db'), { code: 'EAI_AGAIN' });
/** What Drizzle raises when the driver can't reach Postgres: the DNS error wrapped. */
const dbError = () => new Error('Failed query: select 1', { cause: dnsError() });

const COOKIE = settings.session.cookieName;
const SESSION_KEY = settings.session.keyPrefix;

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ routes });
});
afterAll(() => t.close());
afterEach(() => {
  vi.restoreAllMocks();
  t.fakes.redis.clear();
});

const signedInitData = () => generateTelegramInitData({ userId: 42, username: 'ann', firstName: 'Ann' });
const get = (headers: Record<string, string> = {}) => t.client.get('/me', { headers });
const cookie = (sessionId: string) => ({ cookie: `${COOKIE}=${sessionId}` });
const guestLookups = () => vi.spyOn(UsersService.prototype, 'getOrCreateUser');

describe('the initData path', () => {
  it('an invalid initData is a 401', async () => {
    const lookup = guestLookups();
    const response = await get({ initData: 'user=%7B%7D&hash=deadbeef' });
    expect(response.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a malformed hash is a 401, not a 500', async () => {
    const response = await get({ initData: 'user=%7B%7D&hash=%C3%A9' });
    expect(response.status).toBe(401);
  });

  it('a valid initData authenticates', async () => {
    expect((await get({ initData: signedInitData() })).status).toBe(200);
  });

  it.each([
    ['db-operational', dbError()],
    ['gaierror', dnsError()],
    ['pool-timeout', Object.assign(new Error('pool'), { code: 'QUEUE_TIMEOUT' })],
    ['refused', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
  ])('%s is a 503 with Retry-After', async (_name, error) => {
    const lookup = guestLookups().mockRejectedValue(error);
    const response = await get({ initData: signedInitData() });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(String(RETRY_AFTER_SECONDS));
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('an unexpected error is a 500, not a 401', async () => {
    guestLookups().mockRejectedValue(new Error('a bug'));
    const response = await get({ initData: signedInitData() });
    expect(response.status).toBe(500);
  });
});

describe('the session path', () => {
  it('a valid session is its user', async () => {
    const user = await createUser(t.db, { languageCode: 'ru' });
    const id = 'valid-session';
    await t.fakes.redis.set(`${SESSION_KEY}${id}`, JSON.stringify({ user_id: user.id, user_type: user.userType }));

    const response = await get(cookie(id));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ id: user.id, locale: 'ru' });
  });

  it('Redis down is a 503, not the guest', async () => {
    vi.spyOn(t.fakes.redis, 'get').mockRejectedValue(new Error('Connection is closed.'));
    const lookup = guestLookups();

    const response = await get(cookie('abc'));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(String(RETRY_AFTER_SECONDS));
    expect(lookup).not.toHaveBeenCalled(); // never fell back to the guest
  });

  it('the DB down during the user lookup is a 503, not the guest', async () => {
    const user = await createUser(t.db);
    await t.fakes.redis.set(`${SESSION_KEY}abc`, JSON.stringify({ user_id: user.id }));
    vi.spyOn(UsersService.prototype, 'getUserById').mockRejectedValue(dbError());
    const lookup = guestLookups();

    const response = await get(cookie('abc'));

    expect(response.status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['an expired session', null],
    ['a session of a deleted user', JSON.stringify({ user_id: '0195d3a2-0000-7000-8000-000000000000' })],
    ['a session without a user', JSON.stringify({ user_type: 'REGISTERED' })],
    ['a session with a broken user id', JSON.stringify({ user_id: 'not-a-uuid' })],
    ['a session that is not JSON', '{oops'],
  ])('%s falls back to the guest', async (_name, stored) => {
    if (stored) await t.fakes.redis.set(`${SESSION_KEY}expired`, stored);

    const response = await get(cookie('expired'));

    expect(response.status).toBe(200);
    expect((await json(response)).id).toBe(MOCK_GUEST_USER_ID);
  });
});

describe('the guest', () => {
  it('no initData and no cookie is the guest', async () => {
    const validateSession = vi.spyOn(t.fakes.redis, 'get');

    const response = await get();

    expect(response.status).toBe(200);
    expect((await json(response)).id).toBe(MOCK_GUEST_USER_ID);
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('the guest lookup with the DB down is a 503', async () => {
    guestLookups().mockRejectedValue(dbError());
    expect((await get()).status).toBe(503);
  });

  it('the guest is one shared row', async () => {
    await get();
    await get();
    const rows = await t.db.select().from(users).where(eq(users.id, MOCK_GUEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userType: 'GUEST', displayName: 'Guest', timezone: 'UTC' });
  });

  it('takes its language from X-App-Locale, reduced to one we have', async () => {
    expect((await json(await get({ 'x-app-locale': 'ru-RU' }))).locale).toBe('ru');
    expect((await json(await get({ 'x-app-locale': 'de' }))).locale).toBe('en');
  });

  it("uses the row's language without X-App-Locale and with no guestLocale", async () => {
    expect((await json(await get())).locale).toBe('en');
  });

  it("uses the app's guestLocale without X-App-Locale", async () => {
    const withLocale = await createTestApp({ routes, guestLocale: 'ru' });
    try {
      expect((await json(await withLocale.client.get('/me'))).locale).toBe('ru');
    } finally {
      await withLocale.close();
    }
  });

  it('getMockGuestUser is a guest with a fixed old date', () => {
    const guest = getMockGuestUser();
    expect(guest).toMatchObject({ id: MOCK_GUEST_USER_ID, userType: 'GUEST', telegramId: null, emailVerified: false });
    expect(guest.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('debug login (Mock-Platform)', () => {
  const mockInitData = (user: object) =>
    new URLSearchParams({ mock_init_data: 'true', user: JSON.stringify(user) }).toString();

  it('logs in as the user carried in the mock initData, in debug only', async () => {
    const initData = mockInitData({ user_id: 555, first_name: 'Mock', last_name: 'Ed', username: 'mocked' });

    const response = await get({ 'Mock-Platform': 'true', initData });

    expect(response.status).toBe(200);
    const [row] = await t.db.select().from(users).where(eq(users.telegramId, 555));
    expect(row).toMatchObject({ displayName: 'Mock Ed', tgUsername: 'mocked', userType: 'REGISTERED' });
    expect((await json(response)).id).toBe(row?.id);
  });

  it('a name with a stray % still parses', async () => {
    const initData = mockInitData({ user_id: 556, first_name: '100%' });
    await get({ 'Mock-Platform': 'true', initData });
    const [row] = await t.db.select().from(users).where(eq(users.telegramId, 556));
    expect(row?.tgFirstName).toBe('100%');
  });

  it('without settings.debug the header means nothing: the unsigned initData is a 401', async () => {
    vi.spyOn(settings, 'debug', 'get').mockReturnValue(false);
    const response = await get({ 'Mock-Platform': 'true', initData: mockInitData({ user_id: 557 }) });
    expect(response.status).toBe(401);
  });

  it('initData that is not mock data falls through to normal auth', async () => {
    const response = await get({ 'Mock-Platform': 'true', initData: 'user=%7B%7D&hash=deadbeef' });
    expect(response.status).toBe(401);
  });
});
