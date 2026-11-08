import { bigint, boolean, integer, jsonb, pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { enumValues, NotificationTimeSlot } from './enums';

/** Promotional broadcasts queued to be sent during regular notification cycles. */
export const promotionalBroadcasts = pgTable('promotional_broadcasts', {
  id: serial('id').primaryKey(),

  messageType: varchar('message_type', { length: 20 }).notNull(), // 'text', 'photo', 'video', 'animation', 'document'

  messageText: text('message_text'),
  messageHtml: text('message_html'), // formatted version

  mediaFileId: varchar('media_file_id', { length: 255 }),

  caption: text('caption'),
  captionHtml: text('caption_html'), // formatted version

  mediaMetadata: jsonb('media_metadata').$type<Record<string, unknown>>(),

  hasTextFormatting: boolean('has_text_formatting')
    .notNull()
    .$default(() => false),
  hasCaptionFormatting: boolean('has_caption_formatting')
    .notNull()
    .$default(() => false),

  timeSlot: varchar('time_slot', { length: 7, enum: enumValues(NotificationTimeSlot) }).notNull(),
  deadline: timestamptz('deadline').notNull(), // when the broadcast expires
  priority: integer('priority')
    .notNull()
    .$default(() => 80), // higher than regular notifications

  keyboardType: varchar('keyboard_type', { length: 50 }), // 'none', 'main', 'daily'
  keyboardButtonText: varchar('keyboard_button_text', { length: 255 }),

  // Holds the creator's Telegram id, not users.id: the name is kept for compatibility, the semantics are
  // "creator telegram_id". BIGINT: Telegram ids no longer fit int4.
  createdByUserId: bigint('created_by_user_id', { mode: 'number' }).notNull(),
  isActive: boolean('is_active')
    .notNull()
    .$default(() => true),
  completedAt: timestamptz('completed_at'),

  // Delivery tracking. Read receipts / CTR are impossible on Telegram: only sent/success/fail/cycle counters exist.
  sentCount: integer('sent_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failCount: integer('fail_count').notNull().default(0),
  cyclesRun: integer('cycles_run').notNull().default(0),
  lastSentAt: timestamptz('last_sent_at'),

  // NOT enforced by the send pipeline: every active broadcast goes to all time-eligible users.
  targetFilter: jsonb('target_filter').$type<Record<string, unknown>>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PromotionalBroadcast = typeof promotionalBroadcasts.$inferSelect;
export type NewPromotionalBroadcast = typeof promotionalBroadcasts.$inferInsert;
