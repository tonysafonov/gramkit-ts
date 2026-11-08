import { posthog } from '../../clients/posthog';
import { NotificationSlot } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import type { MessageContent } from '../messages/schemas';
import { SendFailure, type SendResult, sendErrorCode, userLanguage } from '../messages/send-failure';
import type { UserSchema } from '../users/schemas';
import { EveningPromotionalBroadcast, MorningPromotionalBroadcast } from './broadcasts';
import type { NotificationClass, NotificationTemplate } from './types';

const logger = getLogger('notifications');

/** Between two sends, under Telegram's broadcast limit. Mutable so a test can switch the wait off. */
export const engineConfig = { sendIntervalMs: 50 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One send of a template: who, which message key, and the send's result. */
export interface DeliveryAttempt {
  user: UserSchema;
  messageKey: string;
  result: SendResult;
}

/**
 * The notification service: scheduling and delivery infrastructure, with the app's templates.
 *
 * Each slot (`morning_notification_job` / `evening_notification_job`, hourly in the worker) sends the users whose
 * local time is `morningHour` / `eveningHour` at most one message, by priority. The scheduled broadcasts from the
 * admin panel (`/admin/broadcasts`) go first: the Morning/EveningPromotionalBroadcast templates send the slot's top
 * active broadcast to everyone in the slot (subclass them and override `filterAudience` to narrow that).
 *
 * To add your own notifications: write classes in `templates.ts` that extend `NotificationTemplate`
 * (`ExampleDailyNotification` and `ExampleEngagementNotification` are examples) and add them to
 * `morningNotifications` or `eveningNotifications`.
 *
 * Per slot, templates run by priority and each user gets at most one message. Every send attempt is recorded in
 * `notification_deliveries` through `recordDelivery` (the single choke point to extend, e.g. with per-user analytics).
 */
export class NotificationsService extends BaseService {
  /** 10am local time. */
  protected readonly morningHour: number = 10;
  /** 7pm local time. */
  protected readonly eveningHour: number = 19;
  /** Your regular notifications. Empty, so users only get the broadcasts you schedule. */
  protected readonly morningNotifications: NotificationClass[] = [];
  protected readonly eveningNotifications: NotificationClass[] = [];

  /** The scheduled morning broadcast first, then the regular morning notifications. */
  getMorningNotificationsWithPromotions(): NotificationClass[] {
    return [MorningPromotionalBroadcast, ...this.morningNotifications];
  }

  /** The scheduled evening broadcast first, then the regular evening notifications. */
  getEveningNotificationsWithPromotions(): NotificationClass[] {
    return [EveningPromotionalBroadcast, ...this.eveningNotifications];
  }

  // ------------------------------------------------------------------ planning

  /** Instantiate the templates in send order: priority descending, shuffled within a priority. */
  buildNotifications(notificationClasses: NotificationClass[], now: Date | null = null): NotificationTemplate[] {
    const groups = new Map<number, NotificationTemplate[]>();
    for (const Cls of notificationClasses) {
      const notification = new Cls().initialize(this.services, now);
      const group = groups.get(notification.priority);
      if (group) group.push(notification);
      else groups.set(notification.priority, [notification]);
    }
    const ordered: NotificationTemplate[] = [];
    for (const priority of [...groups.keys()].sort((a, b) => b - a)) {
      ordered.push(...shuffle(groups.get(priority) ?? [])); // randomize notifications with the same priority
    }
    return ordered;
  }

  /** Who gets which template in one slot (at most one per user). Read-only: nothing is sent. */
  async planSlot(
    notifications: NotificationTemplate[],
    users: UserSchema[],
  ): Promise<[NotificationTemplate, UserSchema[]][]> {
    const planned: [NotificationTemplate, UserSchema[]][] = [];
    const taken = new Set<string>();
    for (const notification of notifications) {
      const available = users.filter((user) => !taken.has(user.id));
      const eligible = available.length ? await notification.filterEligibleUsers(available) : [];
      for (const user of eligible) taken.add(user.id);
      planned.push([notification, eligible]);
    }
    return planned;
  }

  // ------------------------------------------------------------------ sending

  /** Filter `targetUsers` through one template and send it. Returns `[successfulCount, eligibleUsers]`. */
  async sendNotification(
    notification: NotificationTemplate,
    targetUsers: UserSchema[] | null = null,
    slot: string = NotificationSlot.OTHER,
  ): Promise<[number, UserSchema[]]> {
    if (!targetUsers?.length) return [0, []];
    const eligibleUsers = await notification.filterEligibleUsers(targetUsers);
    if (!eligibleUsers.length) return [0, []];
    return [await this.deliver(notification, eligibleUsers, slot), eligibleUsers];
  }

  /** Send one template to already-eligible users, one message (and one log row) per user. */
  async deliver(notification: NotificationTemplate, users: UserSchema[], slot: string): Promise<number> {
    const sendable = await notification.preSendActions(users);
    if (sendable != null) {
      users = sendable;
      if (!users.length) return 0;
    }

    const content = customContent(notification);
    if (content === null) {
      logger.warn('No custom notification content found');
      await notification.postSendActions(users, 0);
      return 0;
    }

    const attempts: DeliveryAttempt[] = [];
    await this.sendEach(notification, users, content, attempts);
    const successfulCount = await this.recordAttempts(notification, attempts, slot);

    this.captureBatchEvent(notification, users, successfulCount, content);
    await notification.postSendActions(users, successfulCount);
    return successfulCount;
  }

  /**
   * The send half of `deliver`, for a caller that records the attempts itself. No delivery rows: `recordAttempts`
   * writes them, so the slow Telegram sends can run outside any transaction and the rows go in a short one
   * afterwards (`user_broadcast_job`). `attempts` fills as the sends go, so whatever went out before a cancellation
   * can still be recorded. No pre/post-send actions or batch event: the caller owns those. An aborted `signal` stops
   * the sends between two users and throws its reason.
   */
  async sendAttempts(
    notification: NotificationTemplate,
    users: UserSchema[],
    attempts: DeliveryAttempt[],
    signal?: AbortSignal,
  ): Promise<void> {
    const content = customContent(notification);
    if (content === null) {
      logger.warn('No custom notification content found');
      return;
    }
    await this.sendEach(notification, users, content, attempts, signal);
  }

  /** One `notification_deliveries` row per attempt; returns how many were delivered. */
  async recordAttempts(notification: NotificationTemplate, attempts: DeliveryAttempt[], slot: string): Promise<number> {
    let successfulCount = 0;
    for (const attempt of attempts) {
      await this.recordDelivery(notification, attempt.user, attempt.messageKey, slot, attempt.result);
      if (attempt.result === true) successfulCount += 1;
    }
    return successfulCount;
  }

  /**
   * Send to each user (custom `content`, or the template's i18n message when it is `undefined`), appending to
   * `attempts`.
   */
  private async sendEach(
    notification: NotificationTemplate,
    users: UserSchema[],
    content: MessageContent | undefined,
    attempts: DeliveryAttempt[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const user of users) {
      // Outside the try below: a stop isn't one user's failure, it ends the run, as a CancelledError does
      signal?.throwIfAborted();
      if (!user.telegramId) continue;
      let messageKey = '';
      let result: SendResult;
      try {
        // everything per user, so one bad key/markup/send can't end the slot for the rest
        messageKey = await notification.getMessageKeyForUser(user);
        const replyMarkup = notification.getReplyMarkup(messageKey, userLanguage(user));
        result =
          content !== undefined
            ? await this.services.messages.sendContent(user.telegramId, content, replyMarkup)
            : await notification.sendToUser(this.services.messages, user, messageKey, replyMarkup);
      } catch (err) {
        logger.error({ err }, `Notification ${notification.templateName} to user ${user.id} failed`);
        result = new SendFailure(SendFailure.OTHER);
      }
      attempts.push({ user, messageKey, result });
      await sleep(engineConfig.sendIntervalMs);
    }
  }

  /** The one place a send attempt is recorded. Extend here (analytics, variants), not at call sites. */
  private async recordDelivery(
    notification: NotificationTemplate,
    user: UserSchema,
    messageKey: string,
    slot: string,
    result: SendResult,
  ): Promise<void> {
    const errorCode = sendErrorCode(result);
    await this.repos.notificationDeliveries.record({
      userId: user.id,
      template: notification.templateName,
      messageKey,
      slot: String(slot),
      delivered: errorCode === null,
      errorCode,
      sentAt: notification.now,
    });
  }

  /** The per-batch PostHog event the templates always sent (`distinctId: "system"`). */
  private captureBatchEvent(
    notification: NotificationTemplate,
    users: UserSchema[],
    successfulCount: number,
    content: MessageContent | undefined,
  ): void {
    const event = notification.getPosthogEvent();
    if (!event) return;
    const properties: Record<string, unknown> = { success_count: successfulCount, total_count: users.length };
    if (content !== undefined) {
      const current = (notification as { currentBroadcast?: { id: number } | null }).currentBroadcast;
      properties.broadcast_id = current?.id ?? null;
      properties.message_type = content.type;
    }
    posthog.capture('system', event, properties);
  }

  /** Send notifications ensuring each user gets at most one, by priority. */
  async sendNotificationsByTime(
    notificationClasses: NotificationClass[],
    hour: number,
    slot: string = NotificationSlot.OTHER,
    now: Date | null = null,
  ): Promise<Record<string, number>> {
    const timeEligibleUsers = await this.services.users.getUsersByLocalTime(hour);
    if (!timeEligibleUsers.length) {
      logger.info(`No users found with local time ${hour}:00`);
      return Object.fromEntries(notificationClasses.map((Cls) => [Cls.name, 0]));
    }

    const notifications = this.buildNotifications(notificationClasses, now);
    const results: Record<string, number> = {};
    for (const [notification, eligibleUsers] of await this.planSlot(notifications, timeEligibleUsers)) {
      results[notification.constructor.name] = eligibleUsers.length
        ? await this.deliver(notification, eligibleUsers, slot)
        : 0;
    }
    return results;
  }

  /** Send morning notifications to eligible users. */
  sendMorningNotification(): Promise<Record<string, number>> {
    return this.sendNotificationsByTime(
      this.getMorningNotificationsWithPromotions(),
      this.morningHour,
      NotificationSlot.MORNING,
    );
  }

  /** Send evening notifications to eligible users. */
  sendEveningNotification(): Promise<Record<string, number>> {
    return this.sendNotificationsByTime(
      this.getEveningNotificationsWithPromotions(),
      this.eveningHour,
      NotificationSlot.EVENING,
    );
  }
}

/**
 * The template's custom content: `undefined` for an i18n template (no `getMessageContent`), `null` when the template
 * has custom content but none to send right now.
 */
function customContent(notification: NotificationTemplate): MessageContent | null | undefined {
  if (typeof notification.getMessageContent !== 'function') return undefined;
  return notification.getMessageContent() ?? null;
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
