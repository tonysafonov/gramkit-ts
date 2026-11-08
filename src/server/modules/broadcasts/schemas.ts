/**
 * Schemas for the admin Broadcasts composer (`/admin/broadcasts`). Port of `core/schemas/broadcasts.py`.
 *
 * A broadcast is either scheduled (sent in the morning/evening notification slot until its deadline) or sent to
 * everyone right away. Delivery tracking is sent/success/fail/cycles only: Telegram exposes neither read receipts nor
 * click-through. `target_filter` is NOT an enforced audience filter: the send pipeline ignores it.
 *
 * Request schemas parse the snake_case wire body and hand the service camelCase keys. A key the client didn't send
 * stays absent (Pydantic's `exclude_unset`), which PATCH relies on.
 */
import { z } from 'zod';

export const MessageType = z.enum(['text', 'photo', 'video', 'animation', 'document']);
export type MessageType = z.infer<typeof MessageType>;
export const KeyboardType = z.enum(['none', 'main', 'daily']);
export type KeyboardType = z.infer<typeof KeyboardType>;
export const TimeSlot = z.enum(['morning', 'evening', 'both']);
export type TimeSlot = z.infer<typeof TimeSlot>;

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;
type Camel<T> = { [K in keyof T as K extends string ? CamelCase<K> : K]: T[K] };

const camelKey = (key: string): string => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The top-level keys of a parsed body as camelCase. Nested JSON (`target_filter`, entities) is left alone. */
function camelize<T extends object>(value: T): Camel<T> {
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [camelKey(key), v])) as Camel<T>;
}

/** A datetime with an offset, or without one (taken as UTC), as a `Date`. */
const dateTime = z.iso
  .datetime({ offset: true, local: true })
  .transform((value) => new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`));

const priority = z.number().int().min(0).max(1000);
const jsonObject = z.record(z.string(), z.unknown());

export const BroadcastCreateRequest = z
  .object({
    message_type: MessageType,
    time_slot: TimeSlot,
    deadline: dateTime,
    priority: priority.default(80),

    // Text content (message_type == 'text').
    message_text: z
      .string()
      .nullish()
      .transform((v) => (typeof v === 'string' ? v.trim() : v)),
    has_text_formatting: z.boolean().default(false),

    // Media content (message_type != 'text').
    media_file_id: z.string().nullish(),
    caption: z.string().nullish(),
    has_caption_formatting: z.boolean().default(false),

    keyboard_type: KeyboardType.default('none'),
    keyboard_button_text: z.string().nullish(),

    // Cosmetic only: NOT enforced by the send pipeline.
    target_filter: jsonObject.nullish(),
  })
  .transform(camelize);
export type BroadcastCreateRequest = z.output<typeof BroadcastCreateRequest>;

export const BroadcastUpdateRequest = z
  .object({
    message_type: MessageType.nullable(),
    deadline: dateTime.nullable(),
    priority: priority.nullable(),
    message_text: z.string().nullable(),
    has_text_formatting: z.boolean().nullable(),
    media_file_id: z.string().nullable(),
    caption: z.string().nullable(),
    has_caption_formatting: z.boolean().nullable(),
    keyboard_type: KeyboardType.nullable(),
    keyboard_button_text: z.string().nullable(),
    target_filter: jsonObject.nullable(),
  })
  .partial()
  .transform(camelize);
export type BroadcastUpdateRequest = z.output<typeof BroadcastUpdateRequest>;

export const BroadcastFormatRequest = z.object({
  text: z.string(),
  entities: z.array(jsonObject).nullish(),
});
export type BroadcastFormatRequest = z.output<typeof BroadcastFormatRequest>;

export const BroadcastPreviewRequest = z
  .object({
    message_type: MessageType,
    message_text: z.string().nullish(),
    message_html: z.string().nullish(),
    has_text_formatting: z.boolean().default(false),
    media_file_id: z.string().nullish(),
    caption: z.string().nullish(),
    caption_html: z.string().nullish(),
    has_caption_formatting: z.boolean().default(false),
    keyboard_type: KeyboardType.default('none'),
    keyboard_button_text: z.string().nullish(),
  })
  .transform(camelize);
export type BroadcastPreviewRequest = z.output<typeof BroadcastPreviewRequest>;

export const BroadcastSendNowRequest = z
  .object({
    broadcast_id: z.number().int().nullish(),
    message_type: MessageType.nullish(),
    message_text: z.string().nullish(),
    message_html: z.string().nullish(),
    has_text_formatting: z.boolean().default(false),
    media_file_id: z.string().nullish(),
    caption: z.string().nullish(),
    caption_html: z.string().nullish(),
    has_caption_formatting: z.boolean().default(false),
    keyboard_type: KeyboardType.default('none'),
    keyboard_button_text: z.string().nullish(),
  })
  .transform(camelize);
export type BroadcastSendNowRequest = z.output<typeof BroadcastSendNowRequest>;

/** The multipart body of `POST /broadcasts/media`. */
export const BroadcastMediaUploadForm = z.object({
  file: z.instanceof(File),
  message_type: z.string(),
});

export const BroadcastIdParam = z.object({ broadcast_id: z.coerce.number().int() });

// Domain views (camelCase, what the service returns) ---------------------------------------------------------------

export interface BroadcastDeliveryStats {
  sentCount: number;
  successCount: number;
  failCount: number;
  cyclesRun: number;
  lastSentAt: Date | null;
}

export interface BroadcastListItem extends BroadcastDeliveryStats {
  id: number;
  messageType: string;
  timeSlot: string;
  preview: string;
  priority: number;
  isActive: boolean;
  deadline: Date;
  completedAt: Date | null;
  keyboardType: string | null;
  createdByUserId: number | null;
  createdAt: Date;
}

export interface BroadcastListResponse {
  active: BroadcastListItem[];
  completed: BroadcastListItem[];
  activeByTimeSlot: Record<string, number>;
}

export interface BroadcastDetail {
  id: number;
  messageType: string;
  messageText: string | null;
  messageHtml: string | null;
  mediaFileId: string | null;
  caption: string | null;
  captionHtml: string | null;
  hasTextFormatting: boolean;
  hasCaptionFormatting: boolean;
  timeSlot: string;
  deadline: Date;
  priority: number;
  keyboardType: string | null;
  keyboardButtonText: string | null;
  isActive: boolean;
  completedAt: Date | null;
  createdByUserId: number | null;
  targetFilter: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date | null;
  stats: BroadcastDeliveryStats;
}

export interface BroadcastMediaUploadResponse {
  fileId: string;
  messageType: string;
}

// Wire shape (snake_case JSON) --------------------------------------------------------------------------------------

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export const toDeliveryStatsResponse = (stats: BroadcastDeliveryStats) => ({
  sent_count: stats.sentCount,
  success_count: stats.successCount,
  fail_count: stats.failCount,
  cycles_run: stats.cyclesRun,
  last_sent_at: iso(stats.lastSentAt),
});

const toListItemResponse = (b: BroadcastListItem) => ({
  id: b.id,
  message_type: b.messageType,
  time_slot: b.timeSlot,
  preview: b.preview,
  priority: b.priority,
  is_active: b.isActive,
  deadline: b.deadline.toISOString(),
  completed_at: iso(b.completedAt),
  keyboard_type: b.keyboardType,
  created_by_user_id: b.createdByUserId,
  created_at: b.createdAt.toISOString(),
  ...toDeliveryStatsResponse(b),
});

export const toBroadcastListResponse = (list: BroadcastListResponse) => ({
  active: list.active.map(toListItemResponse),
  completed: list.completed.map(toListItemResponse),
  active_by_time_slot: list.activeByTimeSlot,
});

export const toBroadcastDetailResponse = (b: BroadcastDetail) => ({
  id: b.id,
  message_type: b.messageType,
  message_text: b.messageText,
  message_html: b.messageHtml,
  media_file_id: b.mediaFileId,
  caption: b.caption,
  caption_html: b.captionHtml,
  has_text_formatting: b.hasTextFormatting,
  has_caption_formatting: b.hasCaptionFormatting,
  time_slot: b.timeSlot,
  deadline: b.deadline.toISOString(),
  priority: b.priority,
  keyboard_type: b.keyboardType,
  keyboard_button_text: b.keyboardButtonText,
  is_active: b.isActive,
  completed_at: iso(b.completedAt),
  created_by_user_id: b.createdByUserId,
  target_filter: b.targetFilter,
  created_at: b.createdAt.toISOString(),
  updated_at: iso(b.updatedAt),
  stats: toDeliveryStatsResponse(b.stats),
});

export const toMediaUploadResponse = (r: BroadcastMediaUploadResponse) => ({
  file_id: r.fileId,
  message_type: r.messageType,
});
