import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  json,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { enumValues, PaymentEventType, PaymentProvider, PaymentStatus } from './enums';
import { subscriptions } from './subscriptions';
import { users } from './users';

export const payments = pgTable(
  'payments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid('user_id').notNull(),
    productId: varchar('product_id', { length: 50 }).notNull(),
    providerId: varchar('provider_id', { length: 14, enum: enumValues(PaymentProvider) }).notNull(),
    amount: doublePrecision('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: varchar('status', { length: 18, enum: enumValues(PaymentStatus) }).notNull(),
    subscriptionId: uuid('subscription_id'),
    // True: an automatic renewal charge (the renewal job, or Telegram renewing a Stars subscription).
    // False: a payment the user made. Set when the row is created and never changed.
    isRecurring: boolean('is_recurring')
      .notNull()
      .$default(() => false),
    wasRewarded: boolean('was_rewarded')
      .notNull()
      .$default(() => false),

    // Idempotency key sent to the provider on create, reused on retry to prevent a double charge. Initial payments
    // use a random uuid; renewals a deterministic per-(subscription, period) key. NULL for non-YooKassa providers.
    idempotencyKey: varchar('idempotency_key', { length: 64 }),

    // Data received from the provider
    providerPaymentId: varchar('provider_payment_id', { length: 255 }),
    providerMetadata: json('provider_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_payments_user_id').on(t.userId),
    index('ix_payments_subscription_id').on(t.subscriptionId),
    index('ix_payments_provider_payment_id').on(t.providerPaymentId),
    // Blocks a concurrent double-create and a post-success duplicate for the same key, while still allowing a
    // dunning retry to re-insert after a terminal-failed attempt (FAILED/CANCELED rows are excluded).
    uniqueIndex('uq_payment_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL AND status NOT IN ('FAILED', 'CANCELED')`),
    foreignKey({ name: 'payments_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    foreignKey({
      name: 'payments_subscription_id_fkey',
      columns: [t.subscriptionId],
      foreignColumns: [subscriptions.id],
    }).onDelete('set null'),
  ],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    paymentId: uuid('payment_id').notNull(),
    providerId: varchar('provider_id', { length: 14, enum: enumValues(PaymentProvider) }).notNull(),
    eventType: varchar('event_type', { length: 17, enum: enumValues(PaymentEventType) }).notNull(),
    timestamp: timestamptz('timestamp').notNull(),
    rawData: json('raw_data').$type<Record<string, unknown>>().notNull(),
    isRecurring: boolean('is_recurring')
      .notNull()
      .$default(() => false),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_payment_events_payment_id').on(t.paymentId),
    foreignKey({
      name: 'payment_events_payment_id_fkey',
      columns: [t.paymentId],
      foreignColumns: [payments.id],
    }).onDelete('cascade'),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
