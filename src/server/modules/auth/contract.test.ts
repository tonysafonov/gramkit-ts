/** Port of `core/testing/contracts/auth.py`: Telegram Mini App auth, the guest fallback, user isolation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, generateTelegramInitData, type TestApp } from '../../testing';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
const json = async (res: Response): Promise<any> => res.json();

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const me = (initData?: string) => t.client.get('/users/me', { headers: initData === undefined ? {} : { initData } });

describe('Telegram auth', () => {
  const initData = generateTelegramInitData({ userId: 987654321, username: 'contract_user' });

  it('a valid signed initData creates a registered user', async () => {
    const response = await me(initData);

    expect(response.status).toBe(200);
    const data = await json(response);
    expect(data.user_type).toBe('REGISTERED');
    expect(data.id).toBeDefined();
  });

  it('the same telegram id returns the same user', async () => {
    const r1 = await me(initData);
    const r2 = await me(initData);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await json(r1)).id).toBe((await json(r2)).id);
  });

  it('a tampered initData (invalid HMAC) is a 401', async () => {
    const response = await me('user=%7B%22id%22%3A123%7D&auth_date=1234567890&hash=invalid');
    expect(response.status).toBe(401);
  });

  it('a signed initData past its max age is a 401, not the user and not the guest', async () => {
    // initData can't be revoked: a leaked one must stop working
    const old = generateTelegramInitData({ userId: 987654321, username: 'contract_user', authDate: 1640000000 });
    const response = await me(old);
    expect(response.status).toBe(401);
  });
});

describe('guest', () => {
  it('no initData header returns the guest', async () => {
    const response = await me();

    expect(response.status).toBe(200);
    const data = await json(response);
    expect(data.user_type).toBe('GUEST');
    expect(data.id).not.toBeNull();
  });
});

describe('user isolation', () => {
  it('two telegram ids create two users', async () => {
    const user1 = await json(await me(generateTelegramInitData({ userId: 111111111, username: 'user_one' })));
    const user2 = await json(await me(generateTelegramInitData({ userId: 222222222, username: 'user_two' })));

    expect(user1.id).not.toBe(user2.id);
    expect(user1.telegram_id).not.toBe(user2.telegram_id);
  });
});

describe('regressions', () => {
  it('a malformed initData is a 401, not a 500', async () => {
    const response = await me('this-is-not-valid-init-data');
    expect(response.status).toBe(401);
  });

  it('an empty initData header returns the guest, not a crash', async () => {
    const response = await me('');

    expect(response.status).toBe(200);
    expect((await json(response)).user_type).toBe('GUEST');
  });
});
