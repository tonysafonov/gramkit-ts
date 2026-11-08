import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, json, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { enumValues, PaymentProvider, SubscriptionStatus } from './enums';
import { users } from './users';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid('user_id').notNull(),
    productId: varchar('product_id', { length: 50 }).notNull(),
    providerId: varchar('provider_id', { length: 14, enum: enumValues(PaymentProvider) }).notNull(),
    status: varchar('status', { length: 8, enum: enumValues(SubscriptionStatus) }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    startDate: timestamptz('start_date').notNull(),
    endDate: timestamptz('end_date').notNull(),
    canceledAt: timestamptz('canceled_at'),
    cancellationReason: varchar('cancellation_reason', { length: 50 }),
    cancellationFeedback: text('cancellation_feedback'),
    recurringDetails: json('recurring_details')
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),

    // Dunning state: how many consecutive renewal attempts have failed, and when the last attempt ran
    // (spaces retries so a daily cron doesn't hammer a declining card).
    failedRenewalCount: integer('failed_renewal_count').notNull().default(0),
    lastRenewalAttemptAt: timestamptz('last_renewal_attempt_at'),

    // The saved card token used for recurring charges. Promoted out of recurring_details so it is typed and
    // queryable; the JSON is kept as a fallback for rows written before this column existed.
    paymentMethodId: varchar('payment_method_id', { length: 64 }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_subscriptions_user_id').on(t.userId),
    // At most one live subscription row per user. Excludes EXPIRED/CANCELED so historical rows are kept; the
    // reuse-first top_up logic means this only bites a concurrent insert.
    uniqueIndex('uq_subscription_active_user').on(t.userId).where(sql`status IN ('ACTIVE', 'PAST_DUE', 'PENDING')`),
    foreignKey({ name: 'subscriptions_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
  ],
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
