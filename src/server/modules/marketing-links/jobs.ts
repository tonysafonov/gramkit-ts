/**
 * Marketing-links worker job: hourly owner alerts about the app's marketing links.
 *
 * The app registers it in its worker (job map + a cron at minute 20). Alerts go to `RBAC__OWNER_IDS` through
 * `sendAdminMessage`; with no owners configured nothing is sent.
 */
import type { Bot } from 'grammy';
import { getLogger } from '../../lib/logging';
import type { Services } from '../../services';
import { sendAdminMessage } from '../messages/admin-messages';

const logger = getLogger('marketing-links-jobs');

/** What a job gets from the worker: the process's bot, and a transaction with services built on it. */
export interface MarketingJobContext {
  bot: Bot;
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T>;
}

/**
 * Hourly: tell the owners about their marketing links: first user, first payment, and a digest on days 1, 7 and 14
 * after the post went out. Each alert goes out once per link.
 */
export async function marketingLinksAlertsJob(ctx: MarketingJobContext): Promise<{ sent: number }> {
  const alerts = await ctx.withTransaction((services) => services.marketingLinks.pendingAlerts());
  for (const alert of alerts) await sendAdminMessage(ctx.bot, alert.text, { silent: alert.silent });
  if (alerts.length > 0) await ctx.withTransaction((services) => services.marketingLinks.markAlertsSent(alerts));
  logger.info(`Job completed: marketing_links_alerts - ${alerts.length} alerts`);
  return { sent: alerts.length };
}
