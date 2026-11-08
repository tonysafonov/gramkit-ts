import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Services } from '../../services';
import type { MessageContent } from '../messages/schemas';
import type { SendResult } from '../messages/send-failure';
import type { MessagesService } from '../messages/service';
import type { UserSchema } from '../users/schemas';

/** A notification class as the engine takes it: instantiated per slot, then `initialize`d with the services. */
export type NotificationClass = new () => NotificationTemplate;

/** Base class for all notifications. */
export abstract class NotificationTemplate {
  protected _services: Services | null = null;
  private _now: Date | null = null;
  /** Higher values are sent first, and a user gets at most one message per slot. */
  priority = 0;
  protected messageKeys: string[] = [];

  /** Attach the services (and a fixed "now" for the slot, e.g. in tests). */
  initialize(services: Services, now: Date | null = null): this {
    this._services = services;
    this._now = now;
    return this;
  }

  protected get services(): Services {
    if (!this._services) throw new Error(`${this.templateName} used before initialize()`);
    return this._services;
  }

  /** The moment the slot is evaluated at (wall clock unless fixed by `initialize`). */
  get now(): Date {
    return this._now ?? new Date();
  }

  /** Stable name stored in `notification_deliveries.template` (the caps query by it). */
  get templateName(): string {
    return this.constructor.name;
  }

  abstract getMessageKey(): Promise<string>;

  /** The message key for one recipient. Default: `getMessageKey()` (random per call, so per user). */
  getMessageKeyForUser(_user: UserSchema): Promise<string> {
    return this.getMessageKey();
  }

  /**
   * Send this template's message to one user (`messages` is the `MessagesService`). Default: the i18n text
   * `messageKey` in the user's language. Override for another kind of message (e.g. a poll); the engine still logs
   * the attempt and handles a blocked bot.
   */
  sendToUser(
    messages: MessagesService,
    user: UserSchema,
    messageKey: string,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<SendResult> {
    return messages.sendLocalized(user, messageKey, false, replyMarkup);
  }

  protected getRandomKey(keys: string[]): string {
    return keys.length ? (keys[Math.floor(Math.random() * keys.length)] ?? '') : '';
  }

  /** Filter users that are eligible to receive this notification. */
  filterEligibleUsers(users: UserSchema[]): Promise<UserSchema[]> {
    return Promise.resolve(users);
  }

  /** The keyboard function for this notification (takes the locale). */
  getKeyboardFunc(): ((locale: string) => InlineKeyboardMarkup) | null {
    return null;
  }

  /** Keyboard for one message. Override when the button depends on the chosen key. */
  getReplyMarkup(_messageKey: string, locale: string): InlineKeyboardMarkup | null {
    return this.getKeyboardFunc()?.(locale) ?? null;
  }

  /**
   * Actions to perform before sending. May return the users to send it to (e.g. only those a gift was actually
   * credited to); `null` sends it to all of `users`.
   */
  preSendActions(_users: UserSchema[]): Promise<UserSchema[] | null | undefined> {
    return Promise.resolve(null);
  }

  /** Actions to perform after sending. */
  postSendActions(_users: UserSchema[], _successfulCount: number): Promise<void> {
    return Promise.resolve();
  }

  /** The PostHog event name for tracking: `HighPriorityEveryone` -> `high_priority_everyone_notification_sent`. */
  getPosthogEvent(): string | null {
    const snake = this.constructor.name
      .replace(/(?<!^)(?=[A-Z])/g, '_')
      .toLowerCase()
      .replace('_notification', '');
    return `${snake}_notification_sent`;
  }

  /**
   * Custom content to send instead of the i18n message (a promotional broadcast). Absent for i18n templates;
   * an empty result means "nothing to send".
   */
  getMessageContent?(): MessageContent | null;
}
