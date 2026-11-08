/**
 * Broadcasts service: the admin composer for promotional broadcasts. Port of `core/services/broadcasts.py`.
 *
 * - list (active / completed) + per-slot active counts for the warning banner
 * - create (a `time_slot='both'` request creates TWO independent rows)
 * - edit (PATCH a single row) / cancel (soft delete: `isActive = false`)
 * - preview (compose the message and send it to the acting admin's OWN chat)
 * - send-now (immediate all-users blast through the `user_broadcast_job` worker job)
 * - media upload (send the uploaded file via the bot to mint a Telegram `file_id`)
 * - format (text + entities to HTML via the shared formatting helpers)
 * - stats (delivery counters)
 *
 * Every MUTATING method records an audit row (`target_type='broadcast'`). Gating (admin vs owner for send-now) is
 * enforced in the router; this service assumes the caller is already authorized. Failures throw
 * `BroadcastNotFoundException` / `InvalidBroadcastException` (the router maps them to 404 / 400); this module knows
 * nothing about HTTP.
 */
import { randomUUID } from 'node:crypto';
import { InputFile } from 'grammy';
import { type NewPromotionalBroadcast, NotificationTimeSlot, type PromotionalBroadcast } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { BroadcastNotFoundException, InvalidBroadcastException } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import { userLanguage } from '../messages/send-failure';
import type { UserSchema } from '../users/schemas';
import {
  type BroadcastContent,
  type BroadcastPayload,
  broadcastContent,
  buildKeyboardMarkup,
  entitiesToHtml,
  type TextEntity,
} from './formatting';
import type { UserBroadcastJobData } from './jobs';
import type {
  BroadcastCreateRequest,
  BroadcastDeliveryStats,
  BroadcastDetail,
  BroadcastListItem,
  BroadcastListResponse,
  BroadcastMediaUploadResponse,
  BroadcastPreviewRequest,
  BroadcastSendNowRequest,
  BroadcastUpdateRequest,
} from './schemas';

const logger = getLogger('broadcasts');

/** Telegram media kinds we accept for upload. */
const MEDIA_KINDS = new Set(['photo', 'video', 'animation', 'document']);

/** PATCH fields whose columns are NOT NULL: an explicit null is a 400, not a failed UPDATE. */
const NOT_NULL_FIELDS = ['messageType', 'deadline', 'priority'] as const;

/** PATCH fields copied to the row as they are. */
const PLAIN_FIELDS = [
  'messageType',
  'deadline',
  'priority',
  'mediaFileId',
  'keyboardType',
  'keyboardButtonText',
  'targetFilter',
] as const;

const MB = 1024 * 1024;
/** Bot API upload limits: 10 MB for photos, 50 MB for other files. Mutable so a test can lower one. */
export const UPLOAD_LIMITS: Record<string, number> = {
  photo: 10 * MB,
  video: 50 * MB,
  animation: 50 * MB,
  document: 50 * MB,
};

const snakeKey = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const toDeliveryStats = (b: PromotionalBroadcast): BroadcastDeliveryStats => ({
  sentCount: b.sentCount,
  successCount: b.successCount,
  failCount: b.failCount,
  cyclesRun: b.cyclesRun,
  lastSentAt: b.lastSentAt,
});

/** A display-friendly preview of the content: the first 50 characters (code points) of the text or caption. */
function displayText(b: PromotionalBroadcast): string {
  const text = b.messageText || b.caption;
  if (text) {
    const chars = Array.from(text);
    return chars.length > 50 ? `${chars.slice(0, 50).join('')}...` : text;
  }
  return `[${b.messageType.toUpperCase()} MESSAGE]`;
}

/** Active = not cancelled/completed AND the deadline is still ahead (an expired row keeps `isActive` until a send cycle flips it). */
const effectiveActive = (b: PromotionalBroadcast): boolean => b.isActive && Date.now() < b.deadline.getTime();

const toListItem = (b: PromotionalBroadcast): BroadcastListItem => ({
  id: b.id,
  messageType: b.messageType,
  timeSlot: String(b.timeSlot),
  preview: displayText(b),
  priority: b.priority,
  isActive: effectiveActive(b),
  deadline: b.deadline,
  completedAt: b.completedAt,
  keyboardType: b.keyboardType,
  createdByUserId: b.createdByUserId,
  createdAt: b.createdAt,
  ...toDeliveryStats(b),
});

const toDetail = (b: PromotionalBroadcast): BroadcastDetail => ({
  id: b.id,
  messageType: b.messageType,
  messageText: b.messageText,
  messageHtml: b.messageHtml,
  mediaFileId: b.mediaFileId,
  caption: b.caption,
  captionHtml: b.captionHtml,
  hasTextFormatting: b.hasTextFormatting,
  hasCaptionFormatting: b.hasCaptionFormatting,
  timeSlot: String(b.timeSlot),
  deadline: b.deadline,
  priority: b.priority,
  keyboardType: b.keyboardType,
  keyboardButtonText: b.keyboardButtonText,
  isActive: effectiveActive(b),
  completedAt: b.completedAt,
  createdByUserId: b.createdByUserId,
  targetFilter: b.targetFilter,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  stats: toDeliveryStats(b),
});

export class BroadcastsService extends BaseService {
  // Reads ---------------------------------------------------------------------------------------------------------

  /** Active + completed broadcasts, plus active counts per time slot. */
  async listBroadcasts(): Promise<BroadcastListResponse> {
    const repo = this.repos.promotionalBroadcasts;
    const active = await repo.listForAdmin({ active: true });
    const completed = await repo.listForAdmin({ active: false });
    const activeByTimeSlot = await repo.countActiveByTimeSlot();
    return { active: active.map(toListItem), completed: completed.map(toListItem), activeByTimeSlot };
  }

  async getBroadcast(broadcastId: number): Promise<BroadcastDetail | null> {
    const broadcast = await this.repos.promotionalBroadcasts.getById(broadcastId);
    return broadcast ? toDetail(broadcast) : null;
  }

  async getStats(broadcastId: number): Promise<BroadcastDeliveryStats> {
    return toDeliveryStats(await this.require(broadcastId));
  }

  // Mutations (each records an audit row) ---------------------------------------------------------------------------

  /** Create one or (for `timeSlot='both'`) two independent broadcast rows. */
  async create(actor: UserSchema, body: BroadcastCreateRequest): Promise<{ ids: number[] }> {
    this.validateContent(body.messageType, body.messageText, body.mediaFileId);
    const creatorId = this.requireCreatorId(actor);

    const base = this.baseCreatePayload(creatorId, body);
    const slots =
      body.timeSlot === 'both'
        ? [NotificationTimeSlot.MORNING, NotificationTimeSlot.EVENING]
        : [body.timeSlot === 'morning' ? NotificationTimeSlot.MORNING : NotificationTimeSlot.EVENING];

    const ids: number[] = [];
    for (const timeSlot of slots) {
      const row = await this.repos.promotionalBroadcasts.create({ ...base, timeSlot });
      ids.push(row.id);
    }

    await this.services.auditLog.record(actor, 'broadcast_create', 'broadcast', ids.join(','), {
      time_slot: body.timeSlot,
      message_type: body.messageType,
      ids,
      rows_created: ids.length,
    });
    return { ids };
  }

  /** PATCH a single broadcast row (a 'both' pair is two independent rows). */
  async edit(actor: UserSchema, broadcastId: number, body: BroadcastUpdateRequest): Promise<BroadcastDetail> {
    const current = await this.require(broadcastId);

    for (const key of NOT_NULL_FIELDS) {
      if (key in body && body[key] === null) throw new InvalidBroadcastException(`${snakeKey(key)} can't be null`);
    }
    const changes: Partial<NewPromotionalBroadcast> = {};
    for (const key of PLAIN_FIELDS) {
      if (key in body) Object.assign(changes, { [key]: body[key] });
    }

    // Text + its HTML/flag are derived together so messageHtml stays consistent. A flag that isn't sent (or is
    // null) keeps the row's current value.
    const textFmt = body.hasTextFormatting;
    if ('messageText' in body) {
      const text = body.messageText ?? null;
      const hasFmt = textFmt == null ? current.hasTextFormatting : textFmt;
      changes.messageText = text;
      changes.messageHtml = text;
      changes.hasTextFormatting = text ? Boolean(hasFmt) : false;
    } else if (textFmt != null) {
      changes.hasTextFormatting = Boolean(textFmt) && Boolean(current.messageText);
    }

    const captionFmt = body.hasCaptionFormatting;
    if ('caption' in body) {
      const caption = body.caption ?? null;
      const hasFmt = captionFmt == null ? current.hasCaptionFormatting : captionFmt;
      changes.caption = caption;
      changes.captionHtml = caption;
      changes.hasCaptionFormatting = caption ? Boolean(hasFmt) : false;
    } else if (captionFmt != null) {
      changes.hasCaptionFormatting = Boolean(captionFmt) && Boolean(current.caption);
    }

    // The row as it would be saved must still be sendable (e.g. not a photo without a file).
    this.validateContent(
      changes.messageType ?? current.messageType,
      'messageText' in changes ? changes.messageText : current.messageText,
      'mediaFileId' in changes ? changes.mediaFileId : current.mediaFileId,
    );

    const changedFields = Object.keys(changes);
    if (changedFields.length > 0) await this.repos.promotionalBroadcasts.update(broadcastId, changes);

    await this.services.auditLog.record(actor, 'broadcast_edit', 'broadcast', String(broadcastId), {
      changed_fields: changedFields.map(snakeKey).sort(),
    });
    return toDetail(await this.require(broadcastId));
  }

  /**
   * Soft-cancel a broadcast: `isActive = false` + a `completedAt` stamp. A row that is no longer active (cancelled,
   * completed or past its deadline) comes back unchanged: no new `completedAt`, no audit row.
   */
  async cancel(actor: UserSchema, broadcastId: number): Promise<BroadcastDetail> {
    const current = await this.require(broadcastId);
    if (!effectiveActive(current)) return toDetail(current);

    await this.repos.promotionalBroadcasts.update(broadcastId, { isActive: false, completedAt: new Date() });

    await this.services.auditLog.record(actor, 'broadcast_cancel', 'broadcast', String(broadcastId), null);
    return toDetail(await this.require(broadcastId));
  }

  /**
   * Immediate all-users blast (owner) through the `user_broadcast_job` worker job: the same one the bots'
   * `/broadcast` confirm flow uses. It sends through the notification engine (delivery log, blocked users skipped)
   * to every user who can get it. A saved row (`broadcastId`) gets its delivery counters moved. Audience targeting
   * is not supported.
   */
  async sendNow(actor: UserSchema, body: BroadcastSendNowRequest): Promise<boolean> {
    const broadcastData = await this.buildSendPayload(body);

    // Audit row FIRST, enqueue LAST: once queued the blast can't be taken back, so nothing that can still fail (and
    // roll the request back) may come after it.
    await this.services.auditLog.record(
      actor,
      'broadcast_send_now',
      'broadcast',
      body.broadcastId != null ? String(body.broadcastId) : null,
      {
        message_type: broadcastData.message_type ?? null,
        from_broadcast_id: body.broadcastId ?? null,
        run_id: broadcastData.run_id,
      },
    );

    const job: UserBroadcastJobData = {
      broadcastData,
      requesterTelegramId: actor.telegramId,
      broadcastId: body.broadcastId ?? null,
    };
    await this.services.worker.enqueueJob('user_broadcast_job', job);
    return true;
  }

  /** Send the composed message to the acting admin's OWN chat (no DB write). */
  async preview(actor: UserSchema, body: BroadcastPreviewRequest): Promise<boolean> {
    if (actor.telegramId == null)
      throw new InvalidBroadcastException('Acting admin has no Telegram chat to preview to');

    const keyboard = buildKeyboardMarkup(
      { keyboard_type: body.keyboardType, keyboard_button_text: body.keyboardButtonText },
      userLanguage(actor),
    );

    let content: BroadcastContent;
    if (body.messageType === 'text') {
      const text = body.hasTextFormatting ? body.messageHtml : body.messageText;
      if (!text) throw new InvalidBroadcastException('Text message requires message_text');
      content = { type: 'text', text, parse_mode: body.hasTextFormatting ? 'HTML' : null };
    } else {
      if (!body.mediaFileId) throw new InvalidBroadcastException('Media message requires media_file_id');
      content = {
        type: body.messageType,
        media_file_id: body.mediaFileId,
        caption: (body.hasCaptionFormatting ? body.captionHtml : body.caption) ?? null,
        parse_mode: body.hasCaptionFormatting ? 'HTML' : null,
      };
    }

    const sent = await this.services.messages.sendContent(actor.telegramId, content, keyboard);
    return sent === true; // a failed send is a `SendFailure` object, not `false`
  }

  /**
   * Send the uploaded file to the acting admin via the bot to mint a file_id. Telegram only hands out a reusable
   * `file_id` once the bot has actually sent the media to a chat. We send it to the acting admin's chat, read the
   * file_id off the returned message, then DELETE that throwaway message so it doesn't linger in the admin's chat
   * looking like a duplicate broadcast: the `file_id` stays valid after the source message is deleted.
   */
  async uploadMedia(
    actor: UserSchema,
    upload: { messageType: string; filename: string; content: Uint8Array },
  ): Promise<BroadcastMediaUploadResponse> {
    const { messageType, content } = upload;
    if (!MEDIA_KINDS.has(messageType)) throw new InvalidBroadcastException(`Unsupported media type: ${messageType}`);
    const chatId = actor.telegramId;
    if (chatId == null) throw new InvalidBroadcastException('Acting admin has no Telegram chat to upload through');
    if (content.byteLength === 0) throw new InvalidBroadcastException('Empty file');
    this.checkUploadSize(messageType, content.byteLength);

    const file = new InputFile(content, upload.filename || 'upload');

    let messageId: number;
    let fileId: string | undefined;
    try {
      const api = this.bot?.api;
      if (!api) throw new Error('No bot to upload through');
      switch (messageType) {
        case 'photo': {
          const message = await api.sendPhoto(chatId, file);
          messageId = message.message_id;
          fileId = message.photo?.at(-1)?.file_id;
          break;
        }
        case 'video': {
          const message = await api.sendVideo(chatId, file);
          messageId = message.message_id;
          fileId = message.video?.file_id;
          break;
        }
        case 'animation': {
          const message = await api.sendAnimation(chatId, file);
          messageId = message.message_id;
          fileId = message.animation?.file_id;
          break;
        }
        default: {
          const message = await api.sendDocument(chatId, file);
          messageId = message.message_id;
          fileId = message.document?.file_id;
        }
      }
    } catch (err) {
      logger.error({ err }, `Broadcast media upload failed: ${err}`);
      throw new InvalidBroadcastException('Failed to upload media via Telegram');
    }
    // Telegram answered with another kind of message (e.g. a GIF sent as a document).
    if (!fileId) throw new InvalidBroadcastException('Failed to upload media via Telegram');

    // Remove the throwaway upload message: the minted file_id remains valid.
    try {
      await this.bot?.api.deleteMessage(chatId, messageId);
    } catch (err) {
      logger.warn({ err }, `Could not delete broadcast upload-preview message: ${err}`);
    }

    return { fileId, messageType };
  }

  /** Refuse a file over Telegram's upload limit for its kind (the router checks it before the body is read). */
  checkUploadSize(messageType: string, size: number | null | undefined): void {
    const limit = UPLOAD_LIMITS[messageType];
    if (limit !== undefined && size != null && size > limit) {
      throw new InvalidBroadcastException(`File too large (max ${Math.floor(limit / MB)} MB for a ${messageType})`);
    }
  }

  /**
   * Convert text + Telegram entities to HTML via the shared formatting helpers. The web composer sends entities as
   * JSON objects (`type/offset/length/url`).
   */
  formatText(text: string, entities: Record<string, unknown>[] | null | undefined): string {
    return entitiesToHtml(text, entities as unknown as TextEntity[] | null | undefined);
  }

  // Internals -----------------------------------------------------------------------------------------------------

  private async require(broadcastId: number): Promise<PromotionalBroadcast> {
    const broadcast = await this.repos.promotionalBroadcasts.getById(broadcastId);
    if (!broadcast) throw new BroadcastNotFoundException('Broadcast not found');
    return broadcast;
  }

  /** The creator's Telegram id goes into `createdByUserId` (NOT NULL). */
  private requireCreatorId(actor: UserSchema): number {
    if (actor.telegramId == null) throw new InvalidBroadcastException('Acting admin has no Telegram id');
    return actor.telegramId;
  }

  private validateContent(
    messageType: string,
    messageText: string | null | undefined,
    mediaFileId: string | null | undefined,
  ): void {
    if (messageType === 'text') {
      if (!messageText) throw new InvalidBroadcastException('Text broadcast requires message_text');
    } else if (!mediaFileId) {
      throw new InvalidBroadcastException(`${messageType} broadcast requires media_file_id`);
    }
  }

  private baseCreatePayload(creatorTelegramId: number, body: BroadcastCreateRequest) {
    const payload = {
      messageType: body.messageType,
      deadline: body.deadline,
      priority: body.priority,
      keyboardType: body.keyboardType,
      keyboardButtonText: body.keyboardButtonText ?? null,
      createdByUserId: creatorTelegramId, // stores the telegram id (standardized)
      isActive: true,
      targetFilter: body.targetFilter ?? null,
    };
    if (body.messageType === 'text') {
      return {
        ...payload,
        messageText: body.messageText ?? null,
        messageHtml: body.messageText ?? null,
        hasTextFormatting: body.hasTextFormatting,
      };
    }
    return {
      ...payload,
      mediaFileId: body.mediaFileId ?? null,
      caption: body.caption ?? null,
      captionHtml: body.caption ?? null,
      hasCaptionFormatting: body.hasCaptionFormatting,
    };
  }

  /**
   * The `broadcast_data` the job consumes (canonical `broadcastContent` keys), from a stored broadcast
   * (`broadcastId`) or inline content. Validated here so a bad payload is a 400 now, not a failed job later.
   * `run_id` makes the job idempotent.
   */
  private async buildSendPayload(body: BroadcastSendNowRequest): Promise<BroadcastPayload & { run_id: string }> {
    let payload: BroadcastPayload;
    if (body.broadcastId != null) {
      const broadcast = await this.require(body.broadcastId);
      payload = {
        message_type: broadcast.messageType,
        message_text: broadcast.messageText,
        message_html: broadcast.messageHtml,
        has_text_formatting: broadcast.hasTextFormatting,
        media_file_id: broadcast.mediaFileId,
        caption: broadcast.caption,
        caption_html: broadcast.captionHtml,
        has_caption_formatting: broadcast.hasCaptionFormatting,
        media_metadata: broadcast.mediaMetadata,
        keyboard_type: broadcast.keyboardType,
        keyboard_button_text: broadcast.keyboardButtonText,
      };
    } else {
      if (!body.messageType) throw new InvalidBroadcastException('send-now requires broadcast_id or message_type');
      payload = {
        message_type: body.messageType,
        message_text: body.messageText ?? null,
        message_html: body.messageHtml || body.messageText || null,
        has_text_formatting: body.hasTextFormatting,
        media_file_id: body.mediaFileId ?? null,
        caption: body.caption ?? null,
        caption_html: body.captionHtml || body.caption || null,
        has_caption_formatting: body.hasCaptionFormatting,
        keyboard_type: body.keyboardType,
        keyboard_button_text: body.keyboardButtonText ?? null,
      };
    }
    broadcastContent(payload); // throws InvalidBroadcastException with the user-facing reason
    return { ...payload, run_id: randomUUID().replaceAll('-', '') };
  }
}
