/**
 * The user-broadcast worker job: the admin panel's "send now" and the bots' `/broadcast`. Port of
 * `core/infrastructure/arq/jobs/broadcasts.py`.
 *
 * One job for every app: the worker registers it as `user_broadcast_job` with a timeout of
 * `USER_BROADCAST_JOB_TIMEOUT` (the worker-wide timeout is far too short for a whole audience). Delivery goes
 * through the notification engine (`NotificationsService.sendAttempts`, then `recordAttempts`): one
 * `notification_deliveries` row per recipient, blocked bots skipped and flagged, the keyboard built per user in their
 * language.
 *
 * Transactions, per chunk of `CHUNK_SIZE` users: the sends run outside any transaction, then the chunk's delivery
 * rows and the saved row's counters go in one short transaction.
 *
 * Stops and re-runs. Every run has a `run_id` (from the payload, else the queue's job id) and logs its deliveries
 * under a per-run message key; a re-run of the same job skips whoever the run already reached. A job that is
 * interrupted (aborted by its timeout or a worker shutdown) records what the in-flight chunk had already sent, tells
 * the requester how far it got, and rethrows. A new send-now is a new run and goes to everyone again.
 */
import { randomUUID } from 'node:crypto';
import { NotificationSlot } from '../../db/schema';
import { t } from '../../lib/i18n';
import { getLogger } from '../../lib/logging';
import type { Services } from '../../services';
import { userLanguage } from '../messages/send-failure';
import { ImmediateBroadcastNotification } from '../notifications/broadcasts';
import { type DeliveryAttempt, NotificationsService } from '../notifications/service';
import { type BroadcastPayload, broadcastContent } from './formatting';

const logger = getLogger('broadcast-job');

/** Users per send phase + recording transaction. Mutable so a test can use a small chunk. */
export const broadcastJobSettings = { chunkSize: 100 };
/** `notification_deliveries.message_key` is this long. */
const MESSAGE_KEY_MAX = 128;

/** Seconds `user_broadcast_job` may run: a send takes ~0.1-0.2 s, so 12 h covers a few hundred thousand users. */
export const USER_BROADCAST_JOB_TIMEOUT = 12 * 60 * 60;

/** What the job needs from the worker: services on a short transaction, or on none, and the queue's job id. */
export interface BroadcastJobContext {
  jobId?: string | null;
  /** Aborted when the worker stops the job (timeout, shutdown). */
  signal?: AbortSignal;
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T>;
  withoutTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T>;
}

/** The job's data, as `BroadcastsService.sendNow` and the bots enqueue it (Python's arq kwargs). */
export interface UserBroadcastJobData {
  broadcastData: BroadcastPayload;
  requesterTelegramId?: number | null;
  broadcastId?: number | null;
}

export interface UserBroadcastJobResult {
  sent: number;
  total: number;
  failed: number;
  success_rate: number;
}

/** The delivery-log key of one run (a saved row's runs keep its id in the key). */
export function broadcastMessageKey(runId: string, broadcastId: number | null = null): string {
  const key = broadcastId !== null ? `promotional_broadcast.${broadcastId}.${runId}` : `broadcast_now.${runId}`;
  return key.slice(0, MESSAGE_KEY_MAX);
}

class Progress {
  total = 0;
  delivered = 0;
  failed = 0;

  get rate(): number {
    return this.total ? Math.round((this.delivered / this.total) * 1000) / 10 : 0;
  }
}

const isCancellation = (err: unknown, ctx: BroadcastJobContext): boolean =>
  ctx.signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Send a broadcast to every user who can get it (in Telegram, bot not blocked). `data.broadcastData` is the content
 * (`broadcastContent` keys), `keyboard_type` / `keyboard_button_text` and `run_id`; the bots' legacy keys still
 * work. `requesterTelegramId` gets the completion (or failure / stopped) message. `broadcastId` is the saved row this
 * run sends, if any: its counters move per chunk (one cycle per run).
 */
export async function userBroadcastJob(
  ctx: BroadcastJobContext,
  { broadcastData, requesterTelegramId = null, broadcastId = null }: UserBroadcastJobData,
): Promise<UserBroadcastJobResult> {
  logger.info(`Job started: user_broadcast - Type: ${broadcastData.message_type}, row: ${broadcastId}`);
  const templateName = ImmediateBroadcastNotification.TEMPLATE_NAME;
  const progress = new Progress();
  try {
    const content = broadcastContent(broadcastData);
    const keyboard = {
      keyboard_type: broadcastData.keyboard_type,
      keyboard_button_text: broadcastData.keyboard_button_text,
    };
    const runId = broadcastData.run_id || ctx.jobId || randomUUID().replaceAll('-', '');
    const messageKey = broadcastMessageKey(String(runId), broadcastId);
    const template = new ImmediateBroadcastNotification(content, keyboard, messageKey);

    // Short transaction: the audience, and whom this run already reached (a re-run).
    const { audience, earlierRows, reached } = await ctx.withTransaction(async (services) => {
      const audience = await services.repos.users.getBroadcastAudience();
      const deliveries = services.repos.notificationDeliveries;
      const earlierRows = await deliveries.countForKey(templateName, messageKey);
      const reached = earlierRows ? await deliveries.deliveredUserIds(templateName, messageKey) : new Set<string>();
      return { audience, earlierRows, reached };
    });
    if (earlierRows) logger.warn(`user_broadcast ${messageKey}: resuming, ${reached.size} users already reached`);

    progress.total = audience.length;
    progress.delivered = reached.size;
    const pending = audience.filter((user) => !reached.has(user.id));
    let newCycle = earlierRows === 0;
    for (const chunk of chunked(pending, broadcastJobSettings.chunkSize)) {
      const attempts: DeliveryAttempt[] = [];
      try {
        // No transaction while the chunk's Telegram sends run.
        await ctx.withoutTransaction(async (services) => {
          const engine = new NotificationsService(services.repos, services.producer, services, services.bot);
          await engine.sendAttempts(template.initialize(services), chunk, attempts, ctx.signal);
        });
      } catch (err) {
        // Stopped mid-chunk (aborted by the timeout or a worker shutdown): log whoever already got it, so the
        // counters stay true and a re-run skips them.
        await recordChunk(ctx, template, attempts, broadcastId, newCycle, progress);
        throw err;
      }
      if (await recordChunk(ctx, template, attempts, broadcastId, newCycle, progress)) newCycle = false;
    }

    await notifyRequester(ctx, requesterTelegramId, 'core.admin.broadcasts.done', {
      sent: progress.delivered,
      total: progress.total,
      rate: progress.rate.toFixed(1),
    });
    logger.info(
      `Job completed: user_broadcast - Sent to ${progress.delivered}/${progress.total} users (${progress.rate.toFixed(1)}%)`,
    );
    return {
      sent: progress.delivered,
      total: progress.total,
      failed: progress.failed,
      success_rate: progress.rate,
    };
  } catch (err) {
    if (isCancellation(err, ctx)) {
      logger.warn(`Job cancelled: user_broadcast - stopped at ${progress.delivered}/${progress.total} users`);
      await notifyRequester(ctx, requesterTelegramId, 'core.admin.broadcasts.stopped', {
        sent: progress.delivered,
        total: progress.total,
      });
      throw err;
    }
    logger.error({ err }, `Job failed: user_broadcast - ${err}`);
    await notifyRequester(ctx, requesterTelegramId, 'core.admin.broadcasts.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Short transaction: a chunk's delivery rows and the saved row's counters. False if nothing was sent. */
async function recordChunk(
  ctx: BroadcastJobContext,
  template: ImmediateBroadcastNotification,
  attempts: DeliveryAttempt[],
  broadcastId: number | null,
  newCycle: boolean,
  progress: Progress,
): Promise<boolean> {
  if (attempts.length === 0) return false;
  const { sent, failed } = await ctx.withTransaction(async (services) => {
    const engine = new NotificationsService(services.repos, services.producer, services, services.bot);
    const sent = await engine.recordAttempts(template.initialize(services), attempts, NotificationSlot.OTHER);
    const failed = attempts.length - sent;
    if (broadcastId !== null) {
      await services.repos.promotionalBroadcasts.recordSendResult(broadcastId, sent, failed, { newCycle });
    }
    return { sent, failed };
  });
  progress.delivered += sent;
  progress.failed += failed;
  return true;
}

/** Tell the admin who started the broadcast how it went, in their language. Never throws. */
async function notifyRequester(
  ctx: BroadcastJobContext,
  telegramId: number | null,
  key: string,
  values: Record<string, unknown>,
): Promise<void> {
  if (!telegramId) return;
  try {
    const locale = await ctx.withTransaction(async (services) => {
      const user = await services.repos.users.getByTelegramId(telegramId);
      return user ? userLanguage(user) : 'en';
    });
    await ctx.withoutTransaction((services) => services.messages.sendMessage(telegramId, t(key, locale, values)));
  } catch (err) {
    logger.error({ err }, `user_broadcast: could not notify the requester ${telegramId}`);
  }
}
