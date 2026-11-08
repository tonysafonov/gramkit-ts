/** Contract tests of `/users/*`, `/friends`, `/add_friend`: status codes and JSON the Python routers give. */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserType, users } from '../../db/schema';
import { asUser, createTestApp, createUser, generateTelegramInitData, type TestApp } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import { json } from './test-json';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const suffix = () => Math.random().toString(36).slice(2, 12);

describe('GET /users/me', () => {
  it('returns the complete profile in snake_case, without the password hash', async () => {
    const user = await createUser(t.db, { passwordHash: 'secret' });
    const res = await t.client.get('/users/me', { headers: asUser(user) });
    expect(res.status).toBe(200);
    const data = await json(res);
    for (const field of ['id', 'telegram_id', 'username', 'user_type', 'created_at', 'seen_features', 'is_onboarded']) {
      expect(data).toHaveProperty(field);
    }
    expect(data.id).toBe(user.id);
    expect(data.telegram_id).toBe(user.telegramId);
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data).not.toHaveProperty('password_hash');
    expect(data).not.toHaveProperty('passwordHash');
    expect(data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('reflects the Telegram initData', async () => {
    const telegramId = 777_000_111;
    const initData = generateTelegramInitData({ userId: telegramId, username: 'test_initdata' });
    const res = await t.client.get('/users/me', { headers: { initData } });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.username).toMatch(/^test_/);
    expect(data.user_type).toBe('REGISTERED');
    expect(data.telegram_id).toBe(telegramId);
  });

  it('users cannot see each other', async () => {
    const a = await t.client.get('/users/me', {
      headers: { initData: generateTelegramInitData({ userId: 333_333_333, username: 'user_alpha' }) },
    });
    const b = await t.client.get('/users/me', {
      headers: { initData: generateTelegramInitData({ userId: 444_444_444, username: 'user_beta' }) },
    });
    const [userA, userB] = [await json(a), await json(b)];
    expect(userA.username).toBe('user_alpha');
    expect(userB.username).toBe('user_beta');
    expect(userA.id).not.toBe(userB.id);
  });
});

describe('PATCH /users/me', () => {
  it('persists changes', async () => {
    const user = await createUser(t.db);
    const patched = await t.client.patch('/users/me', { display_name: 'Updated Name' }, { headers: asUser(user) });
    expect(patched.status).toBe(200);
    expect((await json(patched)).display_name).toBe('Updated Name');
    const got = await t.client.get('/users/me', { headers: asUser(user) });
    expect((await json(got)).display_name).toBe('Updated Name');
  });

  it('is_onboarded=true works and sets the user_onboarded cookie', async () => {
    const user = await createUser(t.db, { isOnboarded: false });
    const res = await t.client.patch('/users/me', { is_onboarded: true }, { headers: asUser(user) });
    expect(res.status).toBe(200);
    expect((await json(res)).is_onboarded).toBe(true);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('user_onboarded=true');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie.toLowerCase()).not.toContain('httponly');
  });

  it('sets no cookie when is_onboarded is not true', async () => {
    const user = await createUser(t.db);
    const res = await t.client.patch('/users/me', { is_onboarded: false }, { headers: asUser(user) });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the old timezone when the new one is invalid, clears a column on explicit null', async () => {
    const user = await createUser(t.db, { timezone: 'UTC', displayName: 'Before' });
    const res = await t.client.patch(
      '/users/me',
      { timezone: 'Nope/Nope', display_name: null },
      { headers: asUser(user) },
    );
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.timezone).toBe('UTC');
    expect(data.display_name).toBeNull();
  });

  it('accepts birth_date as a date and rejects garbage with a 422', async () => {
    const user = await createUser(t.db);
    const ok = await t.client.patch('/users/me', { birth_date: '1990-05-17' }, { headers: asUser(user) });
    expect((await json(ok)).birth_date).toBe('1990-05-17');
    const bad = await t.client.patch('/users/me', { birth_date: 'yesterday' }, { headers: asUser(user) });
    expect(bad.status).toBe(422);
    const wrongType = await t.client.patch('/users/me', { male: 'maybe' }, { headers: asUser(user) });
    expect(wrongType.status).toBe(422);
    expect((await json(wrongType)).detail[0].loc).toEqual(['body', 'male']);
  });

  it('ignores fields the user may not write', async () => {
    const user = await createUser(t.db);
    const res = await t.client.patch(
      '/users/me',
      { role: 'owner', telegram_id: 1, display_name: 'x' },
      { headers: asUser(user) },
    );
    const data = await json(res);
    expect(data.role).toBe('user');
    expect(data.telegram_id).toBe(user.telegramId);
  });
});

describe('PATCH /users/me for the shared guest', () => {
  it('is refused and stores nothing: one visitor would set the profile every logged-out visitor sees', async () => {
    const res = await t.client.patch('/users/me', {
      avatar_url: 'https://attacker.example/pixel.png',
      username: `admin_${suffix()}`,
      display_name: 'Hacked',
    });

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Sign in to edit your profile' });
    // The refusal rolled back the request, the guest row's creation with it: the next request makes it again
    const me = await json(await t.client.get('/users/me'));
    expect(me).toMatchObject({ id: MOCK_GUEST_USER_ID, avatar_url: null, username: null, display_name: 'Guest' });
    const [guest] = await t.db.select().from(users).where(eq(users.id, MOCK_GUEST_USER_ID));
    expect(guest).toMatchObject({ avatarUrl: null, username: null });
  });
});

describe('PATCH /users/me/seen-features', () => {
  const URL = '/users/me/seen-features';

  it('merges by top-level key; a record-valued key is replaced whole', async () => {
    const user = await createUser(t.db);
    const headers = asUser(user);
    const [reveal, whatsnew, nudge] = [`reveal.t_${suffix()}`, `whatsnew.t_${suffix()}`, `nudge.t_${suffix()}`];

    const first = await t.client.patch(URL, { [reveal]: true }, { headers });
    expect(first.status).toBe(200);
    expect((await json(first)).seen_features[reveal]).toBe(true);

    const second = await t.client.patch(URL, { [whatsnew]: { v: 2 } }, { headers });
    expect(second.status).toBe(200);
    const features = (await json(second)).seen_features;
    expect(features[reveal]).toBe(true);
    expect(features[whatsnew]).toEqual({ v: 2 });

    await t.client.patch(URL, { [nudge]: { n: 1, at: '2026-06-01T00:00:00Z' } }, { headers });
    const third = await t.client.patch(URL, { [nudge]: { n: 2, ack: 'dismissed' } }, { headers });
    expect(third.status).toBe(200);
    expect((await json(third)).seen_features[nudge]).toEqual({ n: 2, ack: 'dismissed' });

    const me = (await json(await t.client.get('/users/me', { headers }))).seen_features;
    expect(me[reveal]).toBe(true);
    expect(me[whatsnew]).toEqual({ v: 2 });
    expect(me[nudge]).toEqual({ n: 2, ack: 'dismissed' });
  });

  it('rejects an invalid key with a 422', async () => {
    const user = await createUser(t.db);
    const res = await t.client.patch(URL, { 'Bad Key': true }, { headers: asUser(user) });
    expect(res.status).toBe(422);
  });

  it('rejects an empty patch and a nested record with a 422', async () => {
    const user = await createUser(t.db);
    expect((await t.client.patch(URL, {}, { headers: asUser(user) })).status).toBe(422);
    expect((await t.client.patch(URL, { 'nudge.x': { a: { b: 1 } } }, { headers: asUser(user) })).status).toBe(422);
  });

  it('is forbidden for the shared GUEST user, and stores nothing', async () => {
    // Every logged-out web visitor is the same GUEST row: it never stores gating state.
    const guest = await createUser(t.db, { userType: UserType.GUEST, telegramId: null });
    const key = `reveal.t_${suffix()}`;
    const res = await t.client.patch(URL, { [key]: true }, { headers: asUser(guest) });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Sign in to save seen features' });
    const me = await json(await t.client.get('/users/me', { headers: asUser(guest) }));
    expect(me.user_type).toBe('GUEST');
    expect(me.seen_features).not.toHaveProperty(key);
  });
});

describe('GET /friends and POST /add_friend', () => {
  it('adds a friend and lists them for both users', async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    const added = await t.client.post(`/add_friend?friend_id=${b.id}`, undefined, { headers: asUser(a) });
    expect(added.status).toBe(200);
    expect(await json(added)).toEqual({ status: 'success' });

    const mine = await json(await t.client.get('/friends', { headers: asUser(a) }));
    expect(mine.map((u: { id: string }) => u.id)).toEqual([b.id]);
    expect(mine[0]).not.toHaveProperty('password_hash');
    const theirs = await json(await t.client.get('/friends', { headers: asUser(b) }));
    expect(theirs.map((u: { id: string }) => u.id)).toEqual([a.id]);

    const again = await t.client.post(`/add_friend?friend_id=${b.id}`, undefined, { headers: asUser(a) });
    expect(again.status).toBe(200);
  });

  it('404s for an unknown friend, 422s for a missing or malformed friend_id', async () => {
    const a = await createUser(t.db);
    const unknown = await t.client.post('/add_friend?friend_id=00000000-0000-4000-8000-000000000000', undefined, {
      headers: asUser(a),
    });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ detail: 'Friend not found' });
    expect((await t.client.post('/add_friend', undefined, { headers: asUser(a) })).status).toBe(422);
    const malformed = await t.client.post('/add_friend?friend_id=nope', undefined, { headers: asUser(a) });
    expect(malformed.status).toBe(422);
    expect((await json(malformed)).detail[0].loc).toEqual(['query', 'friend_id']);
  });

  it('the shared guest gets a 401: every logged-out visitor would read its friends, and add them', async () => {
    const friend = await createUser(t.db);
    const unauthenticated = { detail: { error: 'not_authenticated', message: 'Login required' } };

    const list = await t.client.get('/friends');
    expect(list.status).toBe(401);
    expect(await json(list)).toEqual(unauthenticated);
    const added = await t.client.post(`/add_friend?friend_id=${friend.id}`);
    expect(added.status).toBe(401);
    expect(await json(added)).toEqual(unauthenticated);
    const theirs = await json(await t.client.get('/friends', { headers: asUser(friend) }));
    expect(theirs).toEqual([]);
  });

  it('has no friends by default', async () => {
    const a = await createUser(t.db);
    const res = await t.client.get('/friends', { headers: asUser(a) });
    expect(await json(res)).toEqual([]);
  });
});
