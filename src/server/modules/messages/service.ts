import { GrammyError, HttpError, InputFile } from 'grammy';
import type { InlineKeyboardMarkup, InlineQueryResult } from 'grammy/types';
import { posthog } from '../../clients/posthog';
import { BaseService } from '../../lib/base-service';
import { t } from '../../lib/i18n';
import { getLogger } from '../../lib/logging';
import { Repos } from '../../repos';
import type { UserSchema } from '../users/schemas';
import { type AdminMessageOptions, sendAdminMessage } from './admin-messages';
import type { MessageContent } from './schemas';
import { SendFailure, type SendResult, userLanguage } from './send-failure';

export { SendFailure, type SendResult, sendErrorCode, userLanguage } from './send-failure';

const logger = getLogger('messages');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PollOptions {
  /** `"quiz"` with `correctOptionId` for a quiz. */
  pollType?: 'regular' | 'quiz';
  correctOptionId?: number | null;
  explanation?: string | null;
  isAnonymous?: boolean;
  disableNotification?: boolean;
  replyMarkup?: InlineKeyboardMarkup | null;
}

interface PhotoBytesOptions {
  filename?: string;
  caption?: string | null;
  replyMarkup?: InlineKeyboardMarkup | null;
  /** `undefined` sends the caption as plain text: the bot's default parse mode is switched off. */
  parseMode?: string | null;
  disableNotification?: boolean;
}

export class MessagesService extends BaseService {
  private requireBot() {
    if (!this.bot) throw new Error('No bot configured');
    return this.bot;
  }

  /**
   * Run one Telegram send: success returns `true`, a failure a `SendFailure` saying why. On a forbidden error the user
   * is also flagged `bot_blocked_at`. A flood limit is retried once, with the same error handling. Anything that isn't
   * a Telegram API error propagates.
   */
  private async guard(
    telegramId: number | string | null | undefined,
    send: () => Promise<unknown>,
  ): Promise<SendResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await send();
        logger.info(`Target [ID:${telegramId}]: success`);
        return true;
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 400) {
            logger.warn({ err }, 'Telegram server says - Bad Request');
            return new SendFailure(SendFailure.BAD_REQUEST);
          }
          if (err.error_code === 403) {
            logger.warn(`Target [ID:${telegramId}]: got TelegramForbiddenError`);
            await this.markBotBlocked(telegramId);
            return new SendFailure(SendFailure.FORBIDDEN);
          }
          if (err.error_code === 429) {
            const retryAfter = err.parameters.retry_after ?? 0;
            logger.error(`Target [ID:${telegramId}]: Flood limit exceeded. Sleep ${retryAfter}s`);
            if (attempt === 0) {
              await sleep(retryAfter * 1000);
              continue;
            }
            return new SendFailure(SendFailure.OTHER);
          }
          logger.error({ err }, `Target [ID:${telegramId}]: failed`);
          return new SendFailure(SendFailure.OTHER);
        }
        if (err instanceof HttpError) {
          logger.error({ err }, `Target [ID:${telegramId}]: failed`);
          return new SendFailure(SendFailure.OTHER);
        }
        throw err;
      }
    }
    return new SendFailure(SendFailure.OTHER);
  }

  /**
   * Set `users.bot_blocked_at`. Never breaks the send or the caller's transaction: inside one, a savepoint, so a
   * failing UPDATE can't abort it; outside one (a send phase with no transaction), a short one of its own.
   */
  private async markBotBlocked(telegramId: number | string | null | undefined): Promise<void> {
    if (telegramId === null || telegramId === undefined) return;
    try {
      await this.repos.db.transaction(async (tx) => {
        await new Repos(tx).users.markBotBlocked(Number(telegramId), new Date());
      });
    } catch (err) {
      logger.error({ err }, `Target [ID:${telegramId}]: could not flag bot_blocked_at`);
    }
  }

  sendMessage(
    telegramId: number | string,
    text: string,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    parseMode: string | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendMessage(telegramId, text, {
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
        parse_mode: (parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /** Send a native poll (`pollType: "quiz"` with `correctOptionId` for a quiz). Plain text: no parse mode. */
  sendPoll(
    telegramId: number | string,
    question: string,
    options: string[],
    opts: PollOptions = {},
  ): Promise<SendResult> {
    const { pollType = 'regular', correctOptionId = null, explanation, isAnonymous = true } = opts;
    return this.guard(telegramId, () =>
      this.requireBot().api.sendPoll(telegramId, question, options, {
        type: pollType,
        correct_option_ids: correctOptionId === null ? undefined : [correctOptionId],
        explanation: explanation ?? undefined,
        is_anonymous: isAnonymous,
        disable_notification: opts.disableNotification ?? false,
        reply_markup: opts.replyMarkup ?? undefined,
      }),
    );
  }

  sendPhoto(
    telegramId: number | string,
    photoPath: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendPhoto(telegramId, new InputFile(photoPath), {
        caption: caption ?? undefined,
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
      }),
    );
  }

  /** Send a photo using its file_id instead of a local file path. */
  sendPhotoByFileId(
    telegramId: number | string,
    fileId: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    parseMode: string | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendPhoto(telegramId, fileId, {
        caption: caption ?? undefined,
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
        parse_mode: (parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /**
   * Send a photo rendered in memory (e.g. a generated image). Without `parseMode` the caption goes as plain text:
   * the bot's default parse mode is switched off, so user text in it can't break the markup.
   */
  sendPhotoBytes(telegramId: number | string, photo: Uint8Array, opts: PhotoBytesOptions = {}): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendPhoto(telegramId, new InputFile(photo, opts.filename ?? 'photo.jpg'), {
        caption: opts.caption ?? undefined,
        disable_notification: opts.disableNotification ?? false,
        reply_markup: opts.replyMarkup ?? undefined,
        parse_mode: (opts.parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /** Send a video using its file_id. */
  sendVideoByFileId(
    telegramId: number | string,
    fileId: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    parseMode: string | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendVideo(telegramId, fileId, {
        caption: caption ?? undefined,
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
        parse_mode: (parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /** Send an animation/GIF using its file_id. */
  sendAnimationByFileId(
    telegramId: number | string,
    fileId: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    parseMode: string | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendAnimation(telegramId, fileId, {
        caption: caption ?? undefined,
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
        parse_mode: (parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /** Send a document using its file_id. */
  sendDocumentByFileId(
    telegramId: number | string,
    fileId: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    parseMode: string | null = null,
  ): Promise<SendResult> {
    return this.guard(telegramId, () =>
      this.requireBot().api.sendDocument(telegramId, fileId, {
        caption: caption ?? undefined,
        disable_notification: disableNotification,
        reply_markup: replyMarkup ?? undefined,
        parse_mode: (parseMode ?? undefined) as 'HTML' | undefined,
      }),
    );
  }

  /** Send several local photos as one album; the caption goes on the first. */
  sendPhotosMediaGroup(
    telegramId: number | string,
    mediaPaths: string[],
    caption: string | null = null,
    disableNotification = false,
    _replyMarkup: InlineKeyboardMarkup | null = null, // accepted and ignored, as in Python (media groups take none)
  ): Promise<SendResult> {
    const media = mediaPaths.map((path, index) => ({
      type: 'photo' as const,
      media: new InputFile(path),
      caption: index === 0 ? (caption ?? undefined) : undefined,
    }));
    return this.guard(telegramId, () =>
      this.requireBot().api.sendMediaGroup(telegramId, media, { disable_notification: disableNotification }),
    );
  }

  async rawBroadcast(
    telegramIds: (string | number)[],
    text: string,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
  ): Promise<number> {
    let count = 0;
    try {
      for (const telegramId of telegramIds) {
        if ((await this.sendMessage(telegramId, text, disableNotification, replyMarkup)) === true) count += 1;
        await sleep(50);
      }
    } finally {
      logger.info(`${count} messages successful sent.`);
    }
    return count;
  }

  /** Broadcast a photo to several users using its file_id. */
  async rawPhotoBroadcast(
    telegramIds: (string | number)[],
    fileId: string,
    caption: string | null = null,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
  ): Promise<number> {
    let count = 0;
    try {
      for (const telegramId of telegramIds) {
        if ((await this.sendPhotoByFileId(telegramId, fileId, caption, disableNotification, replyMarkup)) === true) {
          count += 1;
        }
        await sleep(50);
      }
    } finally {
      logger.info(`${count} photo messages successfully sent.`);
    }
    return count;
  }

  /**
   * Send one message from a content object (text / photo / video / animation / document): the shape a promotional
   * broadcast's content and `broadcastContent()` produce. The one primitive every broadcast path sends through
   * (scheduled slot, send-now, bot `/broadcast`, preview). A `SendFailure` on failure (a blocked bot is flagged, as
   * for every send here).
   */
  async sendContent(
    telegramId: number,
    content: MessageContent,
    replyMarkup: InlineKeyboardMarkup | null = null,
  ): Promise<SendResult> {
    const type: string = content.type;
    if (content.type === 'text') {
      return this.sendMessage(telegramId, content.text, false, replyMarkup, content.parse_mode ?? null);
    }
    const senders = {
      photo: this.sendPhotoByFileId,
      video: this.sendVideoByFileId,
      animation: this.sendAnimationByFileId,
      document: this.sendDocumentByFileId,
    } as const;
    const send = senders[type as keyof typeof senders];
    if (!send) {
      logger.error(`Unsupported content message type: ${type}`);
      return new SendFailure(SendFailure.OTHER);
    }
    return send.call(
      this,
      telegramId,
      content.media_file_id,
      content.caption ?? null,
      false,
      replyMarkup,
      content.parse_mode ?? null,
    );
  }

  /** Send the i18n text `messageKey` in the user's language. A `SendFailure` on failure. */
  async sendLocalized(
    user: UserSchema,
    messageKey: string,
    disableNotification = false,
    replyMarkup: InlineKeyboardMarkup | null = null,
    formatKwargs: Record<string, unknown> = {},
  ): Promise<SendResult> {
    if (!user.telegramId) return new SendFailure(SendFailure.BAD_REQUEST);
    const text = t(messageKey, userLanguage(user), formatKwargs);
    return this.sendMessage(user.telegramId, text, disableNotification, replyMarkup);
  }

  async broadcast(
    users: UserSchema[],
    messageKey: string,
    disableNotification = false,
    replyMarkupFunc: ((locale: string) => InlineKeyboardMarkup) | null = null,
    posthogEvent: string | null = null,
    formatKwargs: Record<string, unknown> = {},
  ): Promise<number> {
    let count = 0;
    try {
      for (const user of users) {
        if (!user.telegramId) continue;
        const replyMarkup = replyMarkupFunc ? replyMarkupFunc(userLanguage(user)) : null;
        if ((await this.sendLocalized(user, messageKey, disableNotification, replyMarkup, formatKwargs)) === true) {
          count += 1;
        }
        await sleep(50);
      }
    } finally {
      if (posthogEvent) {
        posthog.capture('system', posthogEvent, {
          success_count: count,
          total_count: users.length,
          message_key: messageKey,
        });
      }
      logger.info(`${count} localized messages successfully sent.`);
    }
    return count;
  }

  /** Send an admin message right now (Telegram HTML; see `admin-messages.ts`). */
  adminBroadcast(text: string, options: AdminMessageOptions = {}): Promise<number> {
    return sendAdminMessage(this.requireBot(), text, options);
  }

  /** The id of a prepared inline message the user can share to any chat. */
  async getShareMessageId(telegramId: number, result: InlineQueryResult) {
    const prepared = await this.requireBot().api.savePreparedInlineMessage(telegramId, result, {
      allow_user_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
      allow_bot_chats: true,
    });
    return prepared.id;
  }

  /**
   * Queue an admin message. `text` is Telegram HTML: escape user content with `esc()`. `richHtml` optionally adds a
   * Rich Message body (tables, details); `text` is its fallback. `silent` delivers without sound: use it for
   * routine, non-actionable events.
   */
  async queueAdminBroadcast(text: string, options: { richHtml?: string | null; silent?: boolean } = {}): Promise<void> {
    await this.services.worker.enqueueJob('admin_broadcast_job', {
      text,
      richHtml: options.richHtml ?? null,
      silent: options.silent ?? false,
    });
  }
}
