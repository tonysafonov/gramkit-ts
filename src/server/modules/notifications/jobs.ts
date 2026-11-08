/** Notification worker jobs, hourly: `morning_notification_job` and `evening_notification_job`. */
import { getLogger } from '../../lib/logging';
import type { Services } from '../../services';

const logger = getLogger('notification-jobs');

/** What these jobs need from the worker's context: a transaction with services. */
export interface NotificationJobContext {
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T>;
}

async function runSlot(
  name: 'morning_notification' | 'evening_notification',
  ctx: NotificationJobContext,
  send: (services: Services) => Promise<Record<string, number>>,
): Promise<{ sent: number }> {
  logger.info(`Job started: ${name}`);
  try {
    // One transaction around the slot. The sends are Telegram calls inside it, as in Python's job; a longer slot
    // would want `sendAttempts` / `recordAttempts` split outside it, as `user_broadcast_job` does.
    const result = await ctx.withTransaction(send);
    // Same as Python: the result is keyed by template class name, so "sent" is only ever found on a result that
    // has it; otherwise 0.
    const successfulCount = result.sent ?? 0;
    logger.info(`Job completed: ${name} - Sent to ${successfulCount} users`);
    return { sent: successfulCount };
  } catch (err) {
    logger.error({ err }, `Job failed: ${name} - ${err}`);
    throw err;
  }
}

export function morningNotificationJob(ctx: NotificationJobContext) {
  return runSlot('morning_notification', ctx, (services) => services.notifications.sendMorningNotification());
}

export function eveningNotificationJob(ctx: NotificationJobContext) {
  return runSlot('evening_notification', ctx, (services) => services.notifications.sendEveningNotification());
}
