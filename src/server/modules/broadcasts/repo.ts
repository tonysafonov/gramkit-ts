import { and, asc, count, desc, eq, gt, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type NotificationTimeSlot, type PromotionalBroadcast, promotionalBroadcasts } from '../../db/schema';

const p = promotionalBroadcasts;

export class PromotionalBroadcastsRepo extends BaseRepo<typeof promotionalBroadcasts> {
  constructor(db: Db) {
    super(db, promotionalBroadcasts, promotionalBroadcasts.id);
  }

  /** All active promotional broadcasts of a time slot, highest priority first, then oldest. */
  getActiveByTimeSlot(timeSlot: NotificationTimeSlot): Promise<PromotionalBroadcast[]> {
    return this.db
      .select()
      .from(p)
      .where(and(eq(p.timeSlot, timeSlot), eq(p.isActive, true), gt(p.deadline, new Date())))
      .orderBy(desc(p.priority), asc(p.createdAt));
  }

  getAllActive(): Promise<PromotionalBroadcast[]> {
    return this.db
      .select()
      .from(p)
      .where(and(eq(p.isActive, true), gt(p.deadline, new Date())))
      .orderBy(asc(p.timeSlot), desc(p.priority));
  }

  /** `createdByUserId` stores the creator's Telegram id (see the model note). */
  getByCreator(creatorTelegramId: number): Promise<PromotionalBroadcast[]> {
    return this.db.select().from(p).where(eq(p.createdByUserId, creatorTelegramId)).orderBy(desc(p.createdAt));
  }

  /** Mark broadcasts past their deadline as inactive. Returns how many. */
  async expireOutdatedBroadcasts(): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .update(p)
      .set({ isActive: false, completedAt: now })
      .where(and(eq(p.isActive, true), lte(p.deadline, now)))
      .returning({ id: p.id });
    return rows.length;
  }

  /** Manually deactivate a promotional broadcast. */
  async deactivateBroadcast(broadcastId: number): Promise<boolean> {
    const rows = await this.db.update(p).set({ isActive: false }).where(eq(p.id, broadcastId)).returning({ id: p.id });
    return rows.length > 0;
  }

  /** Recently completed promotional broadcasts: inactive and stamped. */
  getCompletedBroadcasts(limit = 50): Promise<PromotionalBroadcast[]> {
    return this.db
      .select()
      .from(p)
      .where(and(eq(p.isActive, false), isNotNull(p.completedAt)))
      .orderBy(desc(p.completedAt))
      .limit(limit);
  }

  /**
   * Broadcasts for the admin panel, newest first. `active: true` is active rows whose deadline is still ahead (the
   * ones a slot can still send); `false` is cancelled, completed or expired rows; `null` is all rows. An expired row
   * may still have `isActive` set (it's only flipped after a send cycle), so the deadline decides here.
   */
  listForAdmin(options: { active: boolean | null; limit?: number }): Promise<PromotionalBroadcast[]> {
    const now = new Date();
    const filter =
      options.active === true
        ? and(eq(p.isActive, true), gt(p.deadline, now))
        : options.active === false
          ? or(eq(p.isActive, false), lte(p.deadline, now))
          : undefined;
    return this.db
      .select()
      .from(p)
      .where(filter)
      .orderBy(desc(p.createdAt))
      .limit(options.limit ?? 100);
  }

  /**
   * Active, not-yet-expired broadcasts per time slot. The admin UI warns when more than one shares a slot (only the
   * highest-priority one sends per cycle).
   */
  async countActiveByTimeSlot(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ timeSlot: p.timeSlot, count: count() })
      .from(p)
      .where(and(eq(p.isActive, true), gt(p.deadline, new Date())))
      .groupBy(p.timeSlot);
    return Object.fromEntries(rows.map((row) => [String(row.timeSlot), row.count]));
  }

  /**
   * Increment the delivery counters after a send cycle (or one chunk of it): `sentCount += success + fail`, the
   * per-outcome counters, one more cycle when `newCycle` (send-now records per chunk and counts the cycle on its
   * first chunk only), and `lastSentAt` = now. Read receipts / CTR are impossible on Telegram, so only these exist.
   */
  async recordSendResult(broadcastId: number, success: number, fail: number, { newCycle = true } = {}): Promise<void> {
    await this.db
      .update(p)
      .set({
        sentCount: sql`${p.sentCount} + ${success + fail}`,
        successCount: sql`${p.successCount} + ${success}`,
        failCount: sql`${p.failCount} + ${fail}`,
        cyclesRun: sql`${p.cyclesRun} + ${newCycle ? 1 : 0}`,
        lastSentAt: new Date(),
      })
      .where(eq(p.id, broadcastId));
  }
}
