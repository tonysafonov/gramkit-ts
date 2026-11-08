import { bigserial, boolean, foreignKey, index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { users } from './users';

/**
 * One row per attempt to send a scheduled notification to one user. Written only through the notifications
 * service; the lifecycle caps (days between invites, lapse-ladder steps, dormant cadence) are computed from it.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    template: varchar('template', { length: 64 }).notNull(),
    messageKey: varchar('message_key', { length: 128 }).notNull(),
    slot: varchar('slot', { length: 16 }).notNull(), // NotificationSlot
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
    delivered: boolean('delivered').notNull(),
    // null when delivered; else the send failure's code ("forbidden", "bad_request", "other")
    errorCode: varchar('error_code', { length: 32 }),
  },
  (t) => [
    index('ix_notification_deliveries_user_id_sent_at').on(t.userId, t.sentAt),
    foreignKey({
      name: 'notification_deliveries_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
