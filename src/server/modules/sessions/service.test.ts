/** `services/sessions.py` has no Python tests of its own beyond the auth ones: these cover its lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../config';
import { FakeRedis } from '../../testing';
import { SessionsService } from './service';

const redis = new FakeRedis();
const sessions = new SessionsService(redis);
const key = (id: string) => `${settings.session.keyPrefix}${id}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  redis.clear();
});

describe('createSession', () => {
  it('stores the session with its metadata and TTL', async () => {
    const set = vi.spyOn(redis, 'set');

    const id = await sessions.createSession('user-1', 'REGISTERED', { auth_method: 'telegram_code' });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse((await redis.get(key(id))) ?? '')).toMatchObject({
      user_id: 'user-1',
      user_type: 'REGISTERED',
      auth_method: 'telegram_code',
    });
    expect(set.mock.calls[0]?.[2]).toBe(settings.session.expireDays * 86400);
  });
});

describe('validateSession', () => {
  it('returns the data and updates last_accessed', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const id = await sessions.createSession('user-1', 'REGISTERED');
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));

    const data = await sessions.validateSession(id);

    expect(data).toMatchObject({ user_id: 'user-1', last_accessed: '2026-01-02T00:00:00.000Z' });
    expect(JSON.parse((await redis.get(key(id))) ?? '').last_accessed).toBe('2026-01-02T00:00:00.000Z');
  });

  it('extends the TTL', async () => {
    const id = await sessions.createSession('user-1', 'REGISTERED');
    const set = vi.spyOn(redis, 'set');

    await sessions.validateSession(id);

    expect(set).toHaveBeenCalledWith(key(id), expect.any(String), settings.session.expireDays * 86400);
  });

  it('is null for nothing, an unknown id and bad JSON', async () => {
    expect(await sessions.validateSession('')).toBeNull();
    expect(await sessions.validateSession('unknown')).toBeNull();
    await redis.set(key('bad'), '{oops');
    expect(await sessions.validateSession('bad')).toBeNull();
  });

  it('rethrows the infrastructure failing: that is not "no session"', async () => {
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('Connection is closed.'));
    await expect(sessions.validateSession('abc')).rejects.toThrow('Connection is closed.');
  });

  it('is null for any other error', async () => {
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('a bug'));
    expect(await sessions.validateSession('abc')).toBeNull();
  });
});

describe('destroySession', () => {
  it('is true when it was there, false when not', async () => {
    const id = await sessions.createSession('user-1', 'REGISTERED');

    expect(await sessions.destroySession(id)).toBe(true);
    expect(await sessions.destroySession(id)).toBe(false);
    expect(await sessions.destroySession('')).toBe(false);
  });

  it('is false when Redis fails', async () => {
    vi.spyOn(redis, 'delete').mockRejectedValue(new Error('Connection is closed.'));
    expect(await sessions.destroySession('abc')).toBe(false);
  });
});

describe('revokeUserSessions', () => {
  it("voids the user's existing sessions, not later ones or other users'", async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const old = await sessions.createSession('user-1', 'REGISTERED');
    const other = await sessions.createSession('user-2', 'REGISTERED');
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));

    await sessions.revokeUserSessions('user-1');
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    const fresh = await sessions.createSession('user-1', 'REGISTERED');

    expect(await sessions.validateSession(old)).toBeNull();
    expect(await redis.get(key(old))).toBeNull();
    expect(await sessions.validateSession(fresh)).toMatchObject({ user_id: 'user-1' });
    expect(await sessions.validateSession(other)).toMatchObject({ user_id: 'user-2' });
  });

  it('keeps the cutoff a day longer than a session can go unused', async () => {
    const set = vi.spyOn(redis, 'set');

    await sessions.revokeUserSessions('user-1');

    expect(set).toHaveBeenCalledWith(
      key('valid_after:user-1'),
      expect.any(String),
      (settings.session.expireDays + 1) * 86400,
    );
  });
});
