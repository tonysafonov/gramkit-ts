/**
 * The worker's own jobs: core's admin, backup and balance-free set plus the template app's `worker/jobs.py`.
 * Jobs of the other modules (subscriptions, broadcasts, notifications, marketing links) are in `registry.ts`.
 *
 * A job is `(ctx, data) => result`. `data` is what `services.worker.enqueueJob(name, data)` was given: Python passed
 * keyword arguments, so snake_case keys are the contract and the camelCase spelling is accepted too.
 */
import { InputFile } from 'grammy';
import { settings } from '../config';
import { t } from '../lib/i18n';
import { getLogger } from '../lib/logging';
import { type UserBroadcastJobData, userBroadcastJob } from '../modules/broadcasts/jobs';
import { sendAdminMessage } from '../modules/messages/admin-messages';
import { digestRowFns } from '../modules/statistics/metrics';
import { backupDocument, backupFilename, createBackup, sizeDisplay, sizeMb } from '../scripts/common/backup-database';
import type { WorkerContext } from './context';

const logger = getLogger('worker-jobs');

export type JobData = Record<string, unknown>;
export type JobHandler = (ctx: WorkerContext, data: JobData) => Promise<unknown>;

const camel = (key: string): string => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** A payload value by its Python keyword name, or the camelCase spelling. */
export function arg<T>(data: JobData, key: string): T | undefined {
  return (data[key] ?? data[camel(key)]) as T | undefined;
}

/** Same, but the job can't run without it. */
function required<T>(data: JobData, job: string, key: string): T {
  const value = arg<T>(data, key);
  if (value === undefined || value === null) throw new TypeError(`${job}() missing required argument: '${key}'`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send an admin message (Telegram HTML, optional rich body) to all owners. No transaction: external API only. */
export const adminBroadcastJob: JobHandler = async (ctx, data) => {
  const text = required<string>(data, 'admin_broadcast_job', 'text');
  const richHtml = arg<string | null>(data, 'rich_html') ?? null;
  const silent = arg<boolean>(data, 'silent') ?? false;
  logger.info(`Job started: admin_broadcast - Text length: ${text.length}, rich: ${richHtml !== null}`);
  const sent = await sendAdminMessage(ctx.bot, text, { richHtml, silent });
  logger.info(`Job completed: admin_broadcast - Sent to ${sent} admins`);
  return { sent };
};

/**
 * The daily owner digest. A transaction to gather the numbers (fast), then the sends with none. A routine digest is
 * silent; one that failed to gather its numbers is an alert, so it sounds.
 */
export const dailyAdminStatisticsJob: JobHandler = async (ctx) => {
  logger.info('Job started: daily_admin_statistics');
  // Fine for an app that adds nothing; for one that does, `setupRegistries()` didn't run in this process.
  if (digestRowFns().length === 0)
    logger.info('daily_admin_statistics: no app digest rows registered (core rows only)');
  try {
    const { digest, text, richHtml } = await ctx.withTransaction(async (services) => {
      const digest = await services.statistics.getDailyDigest();
      const [text, richHtml] = services.statistics.formatDailyDigest(digest);
      return { digest, text, richHtml };
    });
    const sent = await sendAdminMessage(ctx.bot, text, { richHtml, silent: digest.error === null });
    logger.info(`Job completed: daily_admin_statistics - Sent to ${sent} admins`);
    return { sent };
  } catch (err) {
    logger.error({ err }, `Job failed: daily_admin_statistics - ${err}`);
    throw err;
  }
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Create a database backup (pg_dump, no transaction) and send it to the requester. */
export const backupDatabaseJob: JobHandler = async (ctx, data) => {
  const requester = required<number>(data, 'backup_database_job', 'requester_telegram_id');
  logger.info(`Job started: backup_database - Requester: ${requester}`);
  try {
    const result = await createBackup({ dbConfig: settings.db, appName: settings.appName, compress: true });
    if (!result.success) {
      await ctx.bot.api.sendMessage(requester, `❌ Backup failed: ${result.error}`);
      logger.error(`Job failed: backup_database - ${result.error}`);
      return { success: false, error: result.error };
    }
    const caption =
      `📦 Database Backup\n\n🏷 App: ${result.appName}\n💾 Size: ${sizeDisplay(result)}\n` +
      `🗂 Tables: ${result.tablesCount}\n⏱ Time: ${result.durationSeconds.toFixed(1)}s`;
    await ctx.bot.api.sendDocument(requester, backupDocument(result), { caption });
    logger.info(
      `Job completed: backup_database - File: ${backupFilename(result)}, Size: ${sizeMb(result).toFixed(2)}MB, ` +
        `Duration: ${result.durationSeconds.toFixed(1)}s`,
    );
    return { success: true, file_path: result.filePath, size_mb: sizeMb(result), tables_count: result.tablesCount };
  } catch (err) {
    logger.error({ err }, `Job failed: backup_database - ${err}`);
    try {
      await ctx.bot.api.sendMessage(requester, `❌ Backup failed: ${errorText(err)}`);
    } catch {
      // the requester is told when we can; the job fails either way
    }
    throw err;
  }
};

/** Daily backup to every owner. */
export const scheduledBackupJob: JobHandler = async (ctx) => {
  logger.info('Job started: scheduled_backup');
  const ownerIds = settings.rbac.ownerIds;
  const tellOwners = async (text: string) => {
    for (const ownerId of ownerIds) {
      try {
        await ctx.bot.api.sendMessage(ownerId, text);
      } catch {
        // best effort
      }
    }
  };
  try {
    const result = await createBackup({ dbConfig: settings.db, appName: settings.appName, compress: true });
    if (!result.success) {
      await tellOwners(`❌ Scheduled backup failed: ${result.error}`);
      logger.error(`Job failed: scheduled_backup - ${result.error}`);
      return { success: false, error: result.error };
    }
    const caption =
      `🗓 Scheduled Backup\n\n🏷 App: ${result.appName}\n💾 Size: ${sizeDisplay(result)}\n` +
      `🗂 Tables: ${result.tablesCount}\n⏱ Time: ${result.durationSeconds.toFixed(1)}s`;
    for (const ownerId of ownerIds) {
      try {
        // A file is single-use for a stream: one InputFile per send
        await ctx.bot.api.sendDocument(ownerId, new InputFile(result.filePath, backupFilename(result)), { caption });
        await sleep(100);
      } catch (err) {
        logger.error({ err }, `Failed to send backup to owner ${ownerId}: ${err}`);
      }
    }
    logger.info(
      `Job completed: scheduled_backup - File: ${backupFilename(result)}, Size: ${sizeMb(result).toFixed(2)}MB`,
    );
    return { success: true, file_path: result.filePath, size_mb: sizeMb(result) };
  } catch (err) {
    logger.error({ err }, `Job failed: scheduled_backup - ${err}`);
    await tellOwners(`❌ Scheduled backup failed: ${errorText(err)}`);
    throw err;
  }
};

/** Test error handling in worker jobs. */
export const testErrorJob: JobHandler = async () => {
  throw new Error('Test error');
};

/** A delayed Telegram notification, for the demo. */
export const sendDelayedNotification: JobHandler = async (ctx, data) => {
  const telegramUserId = required<number>(data, 'send_delayed_notification', 'telegram_user_id');
  const delaySeconds = required<number>(data, 'send_delayed_notification', 'delay_seconds');
  logger.info(`Job started: send_delayed_notification - telegram_user_id=${telegramUserId}, delay=${delaySeconds}s`);
  try {
    const lang = await ctx.withTransaction(async (services) => {
      const user = await services.users.getByTelegramId(telegramUserId);
      return user?.languageCode || user?.tgLanguageCode || 'en';
    });
    const message = t('demo.notification.message', lang, { delay_seconds: delaySeconds });
    // Straight through the bot: no transaction for an external API
    await ctx.bot.api.sendMessage(telegramUserId, message, { parse_mode: 'HTML' });
    logger.info(`Job completed: send_delayed_notification - telegram_user_id=${telegramUserId}`);
  } catch (err) {
    logger.error({ err }, `Job failed: send_delayed_notification - ${err}`);
    throw err;
  }
};

/** `user_broadcast_job(broadcast_data, requester_telegram_id=None, broadcast_id=None)`. The key spellings of every
 * producer: the bots send snake_case, `BroadcastsService` camelCase. */
export const userBroadcastJobHandler: JobHandler = async (ctx, data) => {
  const job: UserBroadcastJobData = {
    broadcastData: arg<UserBroadcastJobData['broadcastData']>(
      data,
      'broadcast_data',
    ) as UserBroadcastJobData['broadcastData'],
    requesterTelegramId: arg<number | null>(data, 'requester_telegram_id') ?? null,
    broadcastId: arg<number | null>(data, 'broadcast_id') ?? null,
  };
  if (!job.broadcastData) throw new TypeError("user_broadcast_job() missing required argument: 'broadcast_data'");
  return userBroadcastJob(ctx, job);
};
