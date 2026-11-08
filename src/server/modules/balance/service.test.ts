import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const services = () => new Services(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);

describe('BalanceService', () => {
  it('getBalance is null until getOrCreateBalance creates it, and then it is stable', async () => {
    const user = await createUser(t.db);
    const s = services();
    expect(await s.balance.getBalance(user.id)).toBeNull();
    const created = await s.balance.getOrCreateBalance(user.id);
    expect(created.userId).toBe(user.id);
    const again = await s.balance.getOrCreateBalance(user.id);
    expect(again.createdAt).toEqual(created.createdAt);
    expect((await s.balance.getBalance(user.id))?.userId).toBe(user.id);
  });

  it('updateBalance bumps updated_at, with no values too; unknown user gives null', async () => {
    const user = await createUser(t.db);
    const s = services();
    const created = await s.balance.getOrCreateBalance(user.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Both timestamps come from the database's clock: the test's own can be behind it
    const updated = await s.balance.updateBalance(user.id, {});
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(await s.balance.updateBalance('00000000-0000-4000-8000-000000000000', {})).toBeNull();
  });

  it('the row lock can be taken through the repo', async () => {
    const user = await createUser(t.db);
    const s = services();
    await s.balance.getOrCreateBalance(user.id);
    await t.db.transaction(async (tx) => {
      const locked = await new Repos(tx).balance.getByIdWithLock(user.id);
      expect(locked?.userId).toBe(user.id);
    });
  });
});
