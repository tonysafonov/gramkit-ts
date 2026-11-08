import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, type TestApp } from '../../testing';
import type { Db } from '../client';
import { users } from '../schema';
import { BaseRepo } from './base';

class Repo extends BaseRepo<typeof users> {
  constructor(db: Db) {
    super(db, users, users.id);
  }
}

describe('BaseRepo', () => {
  let t: TestApp;
  let repo: Repo;

  beforeAll(async () => {
    t = await createTestApp();
    repo = new Repo(t.db);
  });

  afterAll(() => t.close());

  it('creates a row, with the column defaults applied', async () => {
    const user = await repo.create({ username: 'created' });

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.userType).toBe('REGISTERED');
    expect(user.role).toBe('user');
    expect(user.timezone).toBe('Europe/Moscow');
    expect(user.seenFeatures).toEqual({});
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('gets a row by id, and null for none', async () => {
    const user = await createUser(t.db);

    expect((await repo.getById(user.id))?.id).toBe(user.id);
    expect(await repo.getById('00000000-0000-0000-0000-00000000dead')).toBeNull();
  });

  it('gets rows by ids', async () => {
    const [a, b] = [await createUser(t.db), await createUser(t.db)];

    const rows = await repo.getByIds([a.id, b.id]);

    expect(rows.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    expect(await repo.getByIds([])).toEqual([]);
  });

  it('updates a row and moves updated_at', async () => {
    const user = await createUser(t.db);

    const updated = await repo.update(user.id, { displayName: 'New name' });

    expect(updated?.displayName).toBe('New name');
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
    expect(await repo.update('00000000-0000-0000-0000-00000000dead', { displayName: 'x' })).toBeNull();
  });

  it('moves only updated_at when there is nothing to update', async () => {
    const user = await repo.create({ username: 'untouched', displayName: 'Same', updatedAt: new Date(0) });

    const updated = await repo.update(user.id, {});

    expect(updated?.displayName).toBe('Same');
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });

  it('upserts on a unique column', async () => {
    const first = await repo.upsert({ telegramId: 777, displayName: 'first' }, [users.telegramId]);
    const second = await repo.upsert({ telegramId: 777, displayName: 'second' }, [users.telegramId]);

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('second');
  });

  it('deletes a row and says whether it did', async () => {
    const user = await createUser(t.db);

    expect(await repo.delete(user.id)).toBe(true);
    expect(await repo.delete(user.id)).toBe(false);
  });

  it('holds an exclusive lock until the transaction ends', async () => {
    const user = await createUser(t.db);

    await t.db.transaction(async (tx) => {
      expect(await new Repo(tx).getByIdWithLock(user.id)).not.toBeNull();

      expect(await repo.getByIdWithLock(user.id, { skipLocked: true })).toBeNull();
      await expect(repo.getByIdWithLock(user.id, { nowait: true })).rejects.toThrow();
    });

    expect(await repo.getByIdWithLock(user.id, { skipLocked: true })).not.toBeNull();
  });

  it('lets shared locks coexist', async () => {
    const user = await createUser(t.db);

    await t.db.transaction(async (tx) => {
      await new Repo(tx).getByIdWithLock(user.id, { read: true });

      expect(await repo.getByIdWithLock(user.id, { read: true, nowait: true })).not.toBeNull();
      await expect(repo.getByIdWithLock(user.id, { nowait: true })).rejects.toThrow();
    });
  });

  it('locks several rows at once', async () => {
    const [a, b] = [await createUser(t.db), await createUser(t.db)];

    await t.db.transaction(async (tx) => {
      expect(await new Repo(tx).getByIdsWithLock([a.id, b.id])).toHaveLength(2);

      await expect(repo.getByIdsWithLock([a.id], { nowait: true })).rejects.toThrow();
    });
  });
});
