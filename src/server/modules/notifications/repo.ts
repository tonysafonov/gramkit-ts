import { and, asc, count, eq, gte, inArray, max } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type NotificationDelivery, notificationDeliveries } from '../../db/schema';

export interface RecordDelivery {
  userId: string;
  template: string;
  messageKey: string;
  slot: string;
  delivered: boolean;
  errorCode?: string | null;
  sentAt?: Date | null;
}

/** The notification delivery log. Batched reads for the per-template caps (no N+1). */
export class NotificationDeliveriesRepo extends BaseRepo<typeof notificationDeliveries> {
  constructor(db: Db) {
    super(db, notificationDeliveries, notificationDeliveries.id);
  }

  record({ userId, template, messageKey, slot, delivered, errorCode = null, sentAt = null }: RecordDelivery) {
    return this.create({ userId, template, messageKey, slot, delivered, errorCode, ...(sentAt ? { sentAt } : {}) });
  }

  /**
   * Users with a DELIVERED row of `template` + `messageKey` (optionally only among `userIds`). A send-now run logs
   * every recipient under its own message key, so a re-run of the same job (a retry of a cancelled job starts from
   * the beginning) skips whoever already got it.
   */
  async deliveredUserIds(template: string, messageKey: string, userIds: Iterable<string> | null = null) {
    const conditions = [
      eq(notificationDeliveries.template, template),
      eq(notificationDeliveries.messageKey, messageKey),
      eq(notificationDeliveries.delivered, true),
    ];
    if (userIds !== null) {
      const ids = [...userIds];
      if (ids.length === 0) return new Set<string>();
      conditions.push(inArray(notificationDeliveries.userId, ids));
    }
    const rows = await this.db
      .select({ userId: notificationDeliveries.userId })
      .from(notificationDeliveries)
      .where(and(...conditions));
    return new Set(rows.map((row) => row.userId));
  }

  /** Rows (any outcome) logged for `template` + `messageKey`: > 0 means the run already started. */
  async countForKey(template: string, messageKey: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.template, template), eq(notificationDeliveries.messageKey, messageKey)));
    return row?.n ?? 0;
  }

  /** `userId -> sentAt` of the latest delivery of `template` (users without one are absent). */
  async lastSentByUser(template: string, userIds: Iterable<string>, { deliveredOnly = true } = {}) {
    const ids = [...userIds];
    const result = new Map<string, Date>();
    if (ids.length === 0) return result;
    const conditions = [eq(notificationDeliveries.template, template), inArray(notificationDeliveries.userId, ids)];
    if (deliveredOnly) conditions.push(eq(notificationDeliveries.delivered, true));
    const rows = await this.db
      .select({ userId: notificationDeliveries.userId, sentAt: max(notificationDeliveries.sentAt) })
      .from(notificationDeliveries)
      .where(and(...conditions))
      .groupBy(notificationDeliveries.userId);
    for (const { userId, sentAt } of rows) if (sentAt) result.set(userId, sentAt);
    return result;
  }

  /**
   * `userId -> [sentAt, ...]` (ascending) of `template` deliveries, optionally since a time. For caps that count per
   * user from a per-user boundary (e.g. "since the last activity"): fetch from the earliest boundary once, then count
   * in memory.
   */
  async sentTimesByUser(
    template: string,
    userIds: Iterable<string>,
    { since = null, deliveredOnly = true }: { since?: Date | null; deliveredOnly?: boolean } = {},
  ) {
    const ids = [...userIds];
    const times = new Map<string, Date[]>();
    if (ids.length === 0) return times;
    const conditions = [eq(notificationDeliveries.template, template), inArray(notificationDeliveries.userId, ids)];
    if (deliveredOnly) conditions.push(eq(notificationDeliveries.delivered, true));
    if (since) conditions.push(gte(notificationDeliveries.sentAt, since));
    const rows: Pick<NotificationDelivery, 'userId' | 'sentAt'>[] = await this.db
      .select({ userId: notificationDeliveries.userId, sentAt: notificationDeliveries.sentAt })
      .from(notificationDeliveries)
      .where(and(...conditions))
      .orderBy(asc(notificationDeliveries.sentAt));
    for (const { userId, sentAt } of rows) {
      const list = times.get(userId);
      if (list) list.push(sentAt);
      else times.set(userId, [sentAt]);
    }
    return times;
  }
}
