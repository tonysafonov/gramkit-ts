import { integer, json, pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from './columns';

/** Dead letter queue for failed webhook processing. */
export const failedWebhooks = pgTable('failed_webhooks', {
  id: serial('id').primaryKey(),
  provider: varchar('provider', { length: 50 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  errorMessage: text('error_message').notNull(),
  errorType: varchar('error_type', { length: 50 }).notNull(),
  retryCount: integer('retry_count')
    .notNull()
    .$default(() => 0),
  lastRetryAt: timestamptz('last_retry_at'),
  resolvedAt: timestamptz('resolved_at'),
  resolvedBy: varchar('resolved_by', { length: 100 }),
  createdAt: createdAt(),
});

export type FailedWebhook = typeof failedWebhooks.$inferSelect;
export type NewFailedWebhook = typeof failedWebhooks.$inferInsert;
