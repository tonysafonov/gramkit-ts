/**
 * Example notification templates. Replace these with your app's actual notification templates.
 *
 * Each notification template should:
 * - extend `NotificationTemplate`
 * - set a priority (higher = sent first)
 * - define message keys for i18n
 * - optionally implement `filterEligibleUsers()` for targeting
 * - optionally implement `getKeyboardFunc()` for interactive buttons
 * - optionally implement `preSendActions()` and `postSendActions()` for logging/tracking
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { getLogger } from '../../lib/logging';
import type { UserSchema } from '../users/schemas';
import { NotificationTemplate } from './types';

const logger = getLogger('notifications.templates');

/**
 * Example daily notification sent to all users. Replace this with your app's actual daily notification logic:
 * daily reminder, daily challenge, daily content, etc.
 */
export class ExampleDailyNotification extends NotificationTemplate {
  constructor() {
    super();
    this.priority = 50; // medium priority
    this.messageKeys = [
      'app.notifications.daily.message_1',
      'app.notifications.daily.message_2',
      'app.notifications.daily.message_3',
    ];
  }

  /** A random message key from the list. */
  async getMessageKey(): Promise<string> {
    return this.getRandomKey(this.messageKeys);
  }

  /** A function that generates a keyboard for this notification, or `null` if no keyboard is needed. */
  override getKeyboardFunc(): ((locale: string) => InlineKeyboardMarkup) | null {
    return null;
  }

  override async preSendActions(users: UserSchema[]): Promise<null> {
    if (users.length) logger.info(`Sending example daily notification to ${users.length} users`);
    return null;
  }
}

/**
 * Example engagement notification for premium/active users. Replace this with your app's actual engagement
 * notification logic: feature announcement, re-engagement, premium benefits, etc.
 */
export class ExampleEngagementNotification extends NotificationTemplate {
  constructor() {
    super();
    this.priority = 40; // lower priority than daily
    this.messageKeys = ['app.notifications.engagement.message_1', 'app.notifications.engagement.message_2'];
  }

  /**
   * Filter users who should receive this notification: only premium users, only active users, only lapsed users,
   * only users without a feature... This example sends to all users.
   */
  override async filterEligibleUsers(users: UserSchema[]): Promise<UserSchema[]> {
    return users;
  }

  async getMessageKey(): Promise<string> {
    return this.getRandomKey(this.messageKeys);
  }

  override async preSendActions(users: UserSchema[]): Promise<null> {
    if (users.length) logger.info(`Sending example engagement notification to ${users.length} users`);
    return null;
  }
}
