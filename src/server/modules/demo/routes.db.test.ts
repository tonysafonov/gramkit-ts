/** `/demo/*` routes that use the database or the queue: notify and the RBAC demo. Fast, so a short-lived test database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

// biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON
const json = async (res: Response): Promise<any> => res.json();

describe('POST /demo/notify', () => {
  it('gives guests (no telegram_id) a 401', async () => {
    const res = await t.client.post('/demo/notify', { delay_seconds: 5 });
    expect(res.status).toBe(401);
    expect((await json(res)).detail).toContain('Telegram authentication required');
  });

  it('enqueues the job deferred by the delay, with the arguments the worker takes', async () => {
    const user = await createUser(t.db, { telegramId: 424_242_001 });
    t.fakes.queue.jobs.length = 0;
    const res = await t.client.post('/demo/notify', { delay_seconds: 7 }, { headers: asUser(user) });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.delay_seconds).toBe(7);
    expect(data.message).toBe('Notification scheduled! Check Telegram in 7 seconds.');
    expect(data).toHaveProperty('scheduled_at');
    expect(t.fakes.queue.jobs).toEqual([
      {
        jobName: 'send_delayed_notification',
        payload: { telegram_user_id: 424_242_001, delay_seconds: 7 },
        options: { deferBy: 7 },
      },
    ]);
  });

  it('clamps the delay to 1-60 seconds', async () => {
    const user = await createUser(t.db, { telegramId: 424_242_002 });
    const high = await t.client.post('/demo/notify', { delay_seconds: 500 }, { headers: asUser(user) });
    expect((await json(high)).delay_seconds).toBe(60);
    const low = await t.client.post('/demo/notify', { delay_seconds: -4 }, { headers: asUser(user) });
    expect((await json(low)).delay_seconds).toBe(1);
  });

  it('defaults the delay to 5 seconds', async () => {
    const user = await createUser(t.db, { telegramId: 424_242_003 });
    const res = await t.client.post('/demo/notify', {}, { headers: asUser(user) });
    expect((await json(res)).delay_seconds).toBe(5);
  });

  it('rejects a malformed JSON body', async () => {
    const user = await createUser(t.db, { telegramId: 424_242_004 });
    const res = await t.client.request('/demo/notify', {
      method: 'POST',
      headers: { ...asUser(user), 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(422);
  });

  it('rejects a delay that is not an integer', async () => {
    const user = await createUser(t.db, { telegramId: 424_242_005 });
    const res = await t.client.post('/demo/notify', { delay_seconds: 'soon' }, { headers: asUser(user) });
    expect(res.status).toBe(422);
  });
});

describe('RBAC demo', () => {
  it('GET /demo/rbac/me gives a user their permissions', async () => {
    const user = await createUser(t.db, { role: 'user' });
    const data = await json(await t.client.get('/demo/rbac/me', { headers: asUser(user) }));
    expect(data).toEqual({ role: 'user', permissions: ['read_own_data', 'update_own_profile'] });
  });

  it('GET /demo/rbac/me gives an owner the full list', async () => {
    const user = await createUser(t.db, { role: 'owner' });
    const data = await json(await t.client.get('/demo/rbac/me', { headers: asUser(user) }));
    expect(data.role).toBe('owner');
    expect(data.permissions).toContain('protected_actions');
    expect(data.permissions).toHaveLength(6);
  });

  it('POST /demo/rbac/set-role changes the role in debug mode', async () => {
    const user = await createUser(t.db, { role: 'user' });
    const res = await t.client.post('/demo/rbac/set-role', { role: 'admin' }, { headers: asUser(user) });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      success: true,
      old_role: 'user',
      new_role: 'admin',
      message: 'Role changed from user to admin. Refresh to see changes.',
    });
    const me = await json(await t.client.get('/demo/rbac/me', { headers: asUser(user) }));
    expect(me.role).toBe('admin');
  });

  it('POST /demo/rbac/set-role rejects an unknown role', async () => {
    const user = await createUser(t.db, { role: 'user' });
    const res = await t.client.post('/demo/rbac/set-role', { role: 'god' }, { headers: asUser(user) });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe("Invalid role. Must be one of: ['user', 'admin', 'owner']");
  });

  it('POST /demo/rbac/set-role needs a role', async () => {
    const user = await createUser(t.db);
    expect((await t.client.post('/demo/rbac/set-role', {}, { headers: asUser(user) })).status).toBe(422);
  });

  it('POST /demo/rbac/protected-action is for owners only', async () => {
    const user = await createUser(t.db, { role: 'admin' });
    const denied = await t.client.post('/demo/rbac/protected-action', undefined, { headers: asUser(user) });
    expect(denied.status).toBe(403);
    expect((await json(denied)).detail).toBe('This action requires owner role. Your role: admin');

    const owner = await createUser(t.db, { role: 'owner' });
    const ok = await t.client.post('/demo/rbac/protected-action', undefined, { headers: asUser(owner) });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({
      success: true,
      message: 'Protected action executed successfully!',
      your_role: 'owner',
    });
  });
});
