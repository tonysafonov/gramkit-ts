/**
 * Broadcast notification templates: how a broadcast goes through the notification engine.
 *
 * - `PromotionalBroadcastNotification` (+ `Morning...` / `Evening...`): the scheduled path. In its slot, the
 *   highest-priority active `promotional_broadcasts` row replaces the regular notifications (priority 1000) until its
 *   deadline; the delivery counters on the row move once per cycle. Apps list the Morning/Evening classes in their
 *   `get*NotificationsWithPromotions()` and may narrow the audience by overriding `filterAudience` (default: everyone
 *   in the slot).
 * - `ImmediateBroadcastNotification`: one send-now / bot `/broadcast` run (`user_broadcast_job`). Built per run with
 *   the content, the keyboard config and a per-run message key; users who already have a delivered row with that key
 *   are skipped (by the job up front, or by `filterEligibleUsers`), so a re-run of the same job doesn't send twice.
 *
 * Both go through the engine and `MessagesService.sendContent` (the scheduled path through
 * `NotificationsService.deliver`; the job through its two halves, `sendAttempts` outside a transaction and
 * `recordAttempts` in a short one): one `notification_deliveries` row per recipient, blocked bots flagged, the
 * keyboard built per user (in the user's language) from the keyboard registry.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { NotificationTimeSlot, type PromotionalBroadcast } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import { buildKeyboardMarkup, type KeyboardConfig } from '../broadcasts/formatting';
import type { MessageContent } from '../messages/schemas';
import type { UserSchema } from '../users/schemas';
import { NotificationTemplate } from './types';

const logger = getLogger('notifications.broadcasts');

/** Above every regular notification: a promo wins its slot. */
export const PROMOTIONAL_BROADCAST_PRIORITY = 1000;

/** A preview of the broadcast content for logs. */
function displayText(broadcast: PromotionalBroadcast): string {
  const preview = (text: string) => text.slice(0, 50) + (text.length > 50 ? '...' : '');
  if (broadcast.messageText) return preview(broadcast.messageText);
  if (broadcast.caption) return preview(broadcast.caption);
  return `[${broadcast.messageType.toUpperCase()} MESSAGE]`;
}

/** The row's content as `MessagesService.sendContent` takes it. */
function contentForSending(broadcast: PromotionalBroadcast): MessageContent {
  if (broadcast.messageType === 'text') {
    return {
      type: 'text',
      text: broadcast.messageHtml || broadcast.messageText || '',
      parse_mode: broadcast.hasTextFormatting ? 'HTML' : null,
    };
  }
  return {
    type: broadcast.messageType as 'photo' | 'video' | 'animation' | 'document',
    media_file_id: broadcast.mediaFileId ?? '',
    caption: broadcast.captionHtml || broadcast.caption,
    parse_mode: broadcast.hasCaptionFormatting ? 'HTML' : null,
    metadata: broadcast.mediaMetadata ?? {},
  };
}

/**
 * Notification template for promotional broadcasts stored in the database.
 *
 * Audience: everyone in the slot, narrowed by `filterAudience` (the app override point; there's no per-broadcast
 * audience choice).
 */
export class PromotionalBroadcastNotification extends NotificationTemplate {
  /** Read by `NotificationsService.captureBatchEvent` (the PostHog broadcast_id). */
  currentBroadcast: PromotionalBroadcast | null = null;

  constructor(private readonly timeSlot: NotificationTimeSlot) {
    super();
    this.priority = PROMOTIONAL_BROADCAST_PRIORITY;
  }

  /** Same for the morning and evening subclasses. */
  override get templateName(): string {
    return 'PromotionalBroadcastNotification';
  }

  override getPosthogEvent(): string | null {
    return 'promotional_broadcast_sent';
  }

  async getMessageKey(): Promise<string> {
    if (!this.currentBroadcast) return 'promotional_broadcast';
    return `promotional_broadcast.${this.currentBroadcast.id}`;
  }

  override async filterEligibleUsers(users: UserSchema[]): Promise<UserSchema[]> {
    const broadcasts = await this.services.repos.promotionalBroadcasts.getActiveByTimeSlot(this.timeSlot);
    const [top] = broadcasts;
    if (!top) return [];
    this.currentBroadcast = top;
    return this.filterAudience(users);
  }

  /** Who in the slot gets the broadcast. Override in the app (e.g. only engaged users). */
  filterAudience(users: UserSchema[]): Promise<UserSchema[]> {
    return Promise.resolve(users);
  }

  override getReplyMarkup(_messageKey: string, locale: string): InlineKeyboardMarkup | null {
    if (!this.currentBroadcast) return null;
    return buildKeyboardMarkup(
      {
        keyboard_type: this.currentBroadcast.keyboardType,
        keyboard_button_text: this.currentBroadcast.keyboardButtonText,
      },
      locale,
    );
  }

  override async preSendActions(users: UserSchema[]): Promise<null> {
    if (users.length && this.currentBroadcast) {
      logger.info(
        `Sending promotional broadcast #${this.currentBroadcast.id} '${displayText(this.currentBroadcast)}' to ` +
          `${users.length} users (deadline: ${this.currentBroadcast.deadline.toISOString()})`,
      );
    }
    return null;
  }

  override async postSendActions(users: UserSchema[], successfulCount: number): Promise<void> {
    const broadcast = this.currentBroadcast;
    if (!broadcast) return;
    // Delivery tracking: record this cycle's outcome. `users` is the eligible-user list that was attempted; the rest
    // are failures. Telegram exposes neither read receipts nor clicks, so we only track sent / success / fail / cycles.
    const attempted = users.filter((user) => user.telegramId !== null).length;
    const failCount = Math.max(0, attempted - successfulCount);
    await this.services.repos.promotionalBroadcasts.recordSendResult(broadcast.id, successfulCount, failCount);

    if (successfulCount > 0) {
      logger.info(
        `Promotional broadcast #${broadcast.id} sent to ${successfulCount} users. ` +
          `Deadline: ${broadcast.deadline.toISOString()}`,
      );
    }
    if (Date.now() >= broadcast.deadline.getTime()) {
      logger.info(`Promotional broadcast #${broadcast.id} has expired`);
      await this.services.repos.promotionalBroadcasts.expireOutdatedBroadcasts();
    }
  }

  override getMessageContent(): MessageContent | null {
    return this.currentBroadcast ? contentForSending(this.currentBroadcast) : null;
  }
}

export class MorningPromotionalBroadcast extends PromotionalBroadcastNotification {
  constructor() {
    super(NotificationTimeSlot.MORNING);
  }
}

export class EveningPromotionalBroadcast extends PromotionalBroadcastNotification {
  constructor() {
    super(NotificationTimeSlot.EVENING);
  }
}

/**
 * One send-now / bot `/broadcast` run, sent through the notification engine.
 *
 * Not a `PromotionalBroadcastNotification`: that one records the row's counters in `postSendActions`; for a send-now
 * run `user_broadcast_job` records them per chunk.
 */
export class ImmediateBroadcastNotification extends NotificationTemplate {
  static readonly TEMPLATE_NAME = 'ImmediateBroadcastNotification';

  /**
   * `keyboard` is the keyboard CONFIG (`keyboard_type` + `keyboard_button_text`): the markup is built per user, in their
   * language.
   */
  constructor(
    private readonly content: MessageContent,
    private readonly keyboard: KeyboardConfig | null,
    private readonly messageKey: string,
  ) {
    super();
    this.priority = PROMOTIONAL_BROADCAST_PRIORITY;
  }

  override get templateName(): string {
    return ImmediateBroadcastNotification.TEMPLATE_NAME;
  }

  /** Send-now never emitted a batch event. */
  override getPosthogEvent(): string | null {
    return null;
  }

  async getMessageKey(): Promise<string> {
    return this.messageKey;
  }

  /** Everyone given, minus whoever this run already reached (a re-run after a worker restart). */
  override async filterEligibleUsers(users: UserSchema[]): Promise<UserSchema[]> {
    const delivered = await this.services.repos.notificationDeliveries.deliveredUserIds(
      this.templateName,
      this.messageKey,
      users.map((user) => user.id),
    );
    return users.filter((user) => !delivered.has(user.id));
  }

  override getReplyMarkup(_messageKey: string, locale: string): InlineKeyboardMarkup | null {
    return buildKeyboardMarkup(this.keyboard, locale);
  }

  override getMessageContent(): MessageContent {
    return this.content;
  }
}
