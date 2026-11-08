/** `PromotionalBroadcastsRepo` against real Postgres. No HTTP. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationTimeSlot, promotionalBroadcasts } from '../../db/schema';
import { Repos } from '../../repos';
import { createTestApp, type TestApp } from '../../testing';
import type { TestServices } from '../../testing/auth';
import { broadcastRow } from './test-helpers';

let t: TestApp<TestServices>;
let repo: Repos['promotionalBroadcasts'];

beforeAll(async () => {
  t = await createTestApp();
  repo = new Repos(t.db).promotionalBroadcasts;
});
afterAll(() => t.close());

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600 * 1000);
const reload = async (id: number) => {
  const [row] = await t.db.select().from(promotionalBroadcasts).where(eq(promotionalBroadcasts.id, id));
  if (!row) throw new Error('missing row');
  return row;
};

describe('recordSendResult', () => {
  it('increments counters and stamps last sent', async () => {
    const row = await repo.create(broadcastRow());

    await repo.recordSendResult(row.id, 8, 2);

    const after = await reload(row.id);
    expect([after.successCount, after.failCount, after.sentCount, after.cyclesRun]).toEqual([8, 2, 10, 1]);
    expect(after.lastSentAt).not.toBeNull();
  });

  it('accumulates across cycles', async () => {
    const row = await repo.create(broadcastRow());

    await repo.recordSendResult(row.id, 5, 0);
    await repo.recordSendResult(row.id, 3, 1);

    const after = await reload(row.id);
    expect([after.successCount, after.failCount, after.sentCount, after.cyclesRun]).toEqual([8, 1, 9, 2]);
  });

  it('newCycle false keeps the cycle count', async () => {
    const row = await repo.create(broadcastRow());

    await repo.recordSendResult(row.id, 2, 1);
    await repo.recordSendResult(row.id, 4, 0, { newCycle: false });

    const after = await reload(row.id);
    expect([after.successCount, after.failCount, after.sentCount, after.cyclesRun]).toEqual([6, 1, 7, 1]);
  });
});

describe('getCompletedBroadcasts', () => {
  it('returns only completed rows (inactive + stamped)', async () => {
    const active = await repo.create(broadcastRow({ isActive: true }));
    const completed = await repo.create(broadcastRow({ isActive: false, completedAt: new Date() }));

    const rows = await repo.getCompletedBroadcasts(100);

    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(completed.id)).toBe(true);
    expect(ids.has(active.id)).toBe(false);
    expect(rows.every((r) => r.isActive === false && r.completedAt !== null)).toBe(true);
  });
});

describe('active by slot', () => {
  it('orders by priority and skips expired and inactive', async () => {
    const evening = NotificationTimeSlot.EVENING;
    const low = await repo.create(broadcastRow({ timeSlot: evening, priority: 10 }));
    const high = await repo.create(broadcastRow({ timeSlot: evening, priority: 900 }));
    const expired = await repo.create(broadcastRow({ timeSlot: evening, priority: 999, deadline: hoursFromNow(-1) }));
    const cancelled = await repo.create(broadcastRow({ timeSlot: evening, priority: 998, isActive: false }));
    const otherSlot = await repo.create(broadcastRow({ timeSlot: NotificationTimeSlot.MORNING, priority: 999 }));

    const rows = await repo.getActiveByTimeSlot(evening);

    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
    for (const gone of [expired, cancelled, otherSlot]) expect(ids).not.toContain(gone.id);
  });

  it('counts active by time slot', async () => {
    const before = await repo.countActiveByTimeSlot();
    await repo.create(broadcastRow({ timeSlot: NotificationTimeSlot.MORNING }));
    await repo.create(broadcastRow({ timeSlot: NotificationTimeSlot.MORNING }));
    await repo.create(broadcastRow({ timeSlot: NotificationTimeSlot.EVENING, deadline: hoursFromNow(-1) }));

    const after = await repo.countActiveByTimeSlot();

    const morning = String(NotificationTimeSlot.MORNING);
    const evening = String(NotificationTimeSlot.EVENING);
    expect((after[morning] ?? 0) - (before[morning] ?? 0)).toBe(2);
    expect(after[evening] ?? 0).toBe(before[evening] ?? 0);
  });
});

describe('listForAdmin', () => {
  it('splits active and cancelled', async () => {
    const active = await repo.create(broadcastRow());
    const cancelled = await repo.create(broadcastRow({ isActive: false, completedAt: new Date() }));

    const activeIds = new Set((await repo.listForAdmin({ active: true })).map((r) => r.id));
    const inactiveIds = new Set((await repo.listForAdmin({ active: false })).map((r) => r.id));

    expect(activeIds.has(active.id) && !inactiveIds.has(active.id)).toBe(true);
    expect(inactiveIds.has(cancelled.id) && !activeIds.has(cancelled.id)).toBe(true);
  });

  it('an expired row counts as completed', async () => {
    // Its isActive is only flipped after a send cycle; the deadline decides for the admin list.
    const expired = await repo.create(broadcastRow({ deadline: hoursFromNow(-1 / 60) }));

    const activeIds = new Set((await repo.listForAdmin({ active: true })).map((r) => r.id));
    const inactiveIds = new Set((await repo.listForAdmin({ active: false })).map((r) => r.id));

    expect(expired.isActive).toBe(true);
    expect(inactiveIds.has(expired.id) && !activeIds.has(expired.id)).toBe(true);
  });

  it('null lists every row', async () => {
    const row = await repo.create(broadcastRow({ isActive: false }));
    expect((await repo.listForAdmin({ active: null })).map((r) => r.id)).toContain(row.id);
  });
});

describe('expiry and deactivation', () => {
  it('expireOutdatedBroadcasts flips past-deadline rows and stamps them', async () => {
    const past = await repo.create(broadcastRow({ deadline: hoursFromNow(-2) }));
    const future = await repo.create(broadcastRow());

    expect(await repo.expireOutdatedBroadcasts()).toBeGreaterThanOrEqual(1);

    const after = await reload(past.id);
    expect([after.isActive, after.completedAt !== null]).toEqual([false, true]);
    expect((await reload(future.id)).isActive).toBe(true);
  });

  it('deactivateBroadcast', async () => {
    const row = await repo.create(broadcastRow());
    expect(await repo.deactivateBroadcast(row.id)).toBe(true);
    expect((await reload(row.id)).isActive).toBe(false);
    expect(await repo.deactivateBroadcast(99999999)).toBe(false);
  });

  it('getByCreator takes a telegram id (a number beyond int4)', async () => {
    const row = await repo.create(broadcastRow({ createdByUserId: 7_934_526_008 }));
    expect((await repo.getByCreator(7_934_526_008)).map((r) => r.id)).toEqual([row.id]);
  });
});
