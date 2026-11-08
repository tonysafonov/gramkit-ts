/**
 * `/start link_<token>`: link a Telegram account to a web user (email auth).
 *
 * The web gets `bot_url` from `POST /auth/link/telegram/start` and polls `/auth/link/telegram/poll`. The user opens the
 * link, the bot asks them to confirm and names the web account; the button puts the Telegram data on that user.
 *
 * Python links on the `/start` itself, so a victim tricked into opening someone's link had their Telegram attached to
 * that person's web account (and later opened the Mini App inside it). The button and the account it names are the
 * check.
 *
 * Only in a private chat, and the button works only for whoever opened the link: in a group another member would press
 * it and get their Telegram attached to the account of whoever started the link.
 */
import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../../bot/context';
import { getLogger } from '../../lib/logging';
import { esc } from '../messages/admin-messages';
import type { UserSchema } from '../users/schemas';
import { TelegramLinkException } from './schemas';

const logger = getLogger('bot-telegram-link');

const LINK_PREFIX = 'link_';
/** The confirm button's callback data: `link_ok:<token>` (51 bytes for a real token, under Telegram's 64). */
export const LINK_CONFIRM_PREFIX = 'link_ok:';

const INVALID = 'This link has expired or is invalid.\n\nPlease go back to the website and try again.';
const NOT_YOURS = 'This button is not for you.\n\nOpen the link from the website yourself.';

export const telegramLinkComposer = new Composer<BotContext>();

/** `a***@example.com`: enough for the owner to recognise, not enough to learn an address from a link. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** How the confirmation names the web account. */
function accountLabel(user: UserSchema | null): string {
  if (user?.email) return maskEmail(user.email);
  if (user?.username) return `@${user.username}`;
  return 'a web account';
}

telegramLinkComposer.on('message').command('start', async (ctx, next) => {
  if (!ctx.match.startsWith(LINK_PREFIX)) return next();

  if (ctx.chat.type !== 'private') {
    // No button where someone else could press it, and no reply to point a group at the bot
    logger.warn(`Telegram link opened outside a private chat: chat_type=${ctx.chat.type}, telegram_id=${ctx.from.id}`);
    return;
  }

  const token = ctx.match.slice(LINK_PREFIX.length);
  if (!token) {
    await ctx.reply('Invalid link.');
    return;
  }
  const preview = `${token.slice(0, 8)}...`;
  logger.info(`Telegram link attempt: token=${preview}, telegram_id=${ctx.from.id}`);

  const userId = await ctx.services.telegramLink.getPendingUserId(token);
  if (!userId) {
    logger.warn(`Link token not found or expired: ${preview}`);
    await ctx.reply(INVALID);
    return;
  }
  const user = await ctx.services.users.getUserById(userId);

  await ctx.services.telegramLink.bindSender(token, ctx.from.id);
  await ctx.reply(
    `Link this Telegram account to ${esc(accountLabel(user))}?\n\n` +
      "You will be able to log in to that account with Telegram. If it isn't yours, ignore this message.",
    { reply_markup: new InlineKeyboard().text('Link', `${LINK_CONFIRM_PREFIX}${token}`) },
  );
});

telegramLinkComposer.callbackQuery(/^link_ok:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const token = ctx.match[1] ?? '';
  const preview = `${token.slice(0, 8)}...`;
  const tgUser = ctx.from;
  logger.info(`Telegram link confirmed: token=${preview}, telegram_id=${tgUser.id}`);

  if (!(await ctx.services.telegramLink.getPendingUserId(token))) {
    logger.warn(`Link token not found or expired: ${preview}`);
    await ctx.reply(INVALID);
    return;
  }
  // The presser's Telegram is what gets linked: they must be who opened the link, in their own chat with the bot
  if (ctx.chat?.type !== 'private' || !(await ctx.services.telegramLink.isSender(token, tgUser.id))) {
    logger.warn(`Link button pressed by someone else: token=${preview}, telegram_id=${tgUser.id}`);
    await ctx.reply(NOT_YOURS);
    return;
  }

  try {
    const result = await ctx.services.telegramLink.completeLink(token, tgUser.id, {
      tgFirstName: tgUser.first_name || 'User',
      tgLastName: tgUser.last_name ?? null,
      tgUsername: tgUser.username ?? null,
      tgLanguageCode: tgUser.language_code ?? null,
      tgIsBot: tgUser.is_bot,
      tgIsPremium: tgUser.is_premium ?? null,
    });

    logger.info(`Telegram link completed: token=${preview}, user_id=${result.userId}`);

    await ctx.reply(
      'Account linked successfully!\n\n' +
        'Your Telegram account is now connected to your web account. You can return to the website.',
    );
  } catch (err) {
    if (!(err instanceof TelegramLinkException)) throw err;

    if (err.errorCode === 'token_invalid') {
      logger.warn(`Link token not found or expired: ${preview}`);
      await ctx.reply(INVALID);
    } else if (err.errorCode === 'telegram_already_used') {
      logger.warn(`Telegram already linked: telegram_id=${tgUser.id}`);
      await ctx.reply(
        'This Telegram account is already linked to another account.\n\n' +
          'If you want to link to a different account, please unlink it first.',
      );
    } else if (err.errorCode === 'user_not_found') {
      logger.error(`User not found for link token: ${preview}`);
      await ctx.reply('Account not found.\n\nPlease go back to the website and try again.');
    } else {
      logger.error(`Unexpected error linking Telegram: ${err.errorCode}`);
      await ctx.reply('Failed to link account.\n\nPlease try again later or contact support.');
    }
  }
});
