import { Composer } from 'grammy';
import { settings } from '../../config';
import { getLogger } from '../../lib/logging';
import type { BotContext } from '../context';
import { adminMiddleware } from '../middlewares/admin';

const logger = getLogger('bot-admin');

const ownerOnly = () => adminMiddleware(() => settings.rbac.ownerIds);

/**
 * Core admin commands: `/backup` and `/stats`. Included AFTER the app's own admin composer, so an app's own handler
 * for the same command wins.
 */
export const coreAdminComposer = new Composer<BotContext>();

/** Creates a database backup and sends it to the admin. */
coreAdminComposer.command('backup', ownerOnly(), async (ctx) => {
  const { user, services } = ctx;
  if (!user?.telegramId) return;

  await ctx.reply('⏳ Creating database backup...');

  try {
    // The job sends the file when done
    await services.worker.enqueueJob('backup_database_job', { requester_telegram_id: user.telegramId });
    await ctx.reply("✅ Backup job queued! You'll receive the file shortly.");
    logger.info(`Backup job queued by admin ${user.telegramId}`);
  } catch (err) {
    logger.error({ err }, `Failed to queue backup job: ${err}`);
    await ctx.reply(`❌ Failed to start backup: ${err instanceof Error ? err.message : err}`);
  }
});

/** Sends the daily digest (so far) to the requesting owner only. */
coreAdminComposer.command('stats', ownerOnly(), async (ctx) => {
  const { user, services } = ctx;
  if (!user?.telegramId) return;

  try {
    const digest = await services.statistics.getDailyDigest();
    const [text, richHtml] = services.statistics.formatDailyDigest(digest);
    // Loud and only to the requester: they asked for it.
    await services.messages.adminBroadcast(text, { richHtml, chatIds: [user.telegramId] });
  } catch (err) {
    logger.error({ err }, `Failed to manually generate daily statistics: ${err}`);
    await ctx.reply(`❌ Failed to generate statistics: ${err instanceof Error ? err.message : err}`, {
      parse_mode: undefined,
    });
  }
});
