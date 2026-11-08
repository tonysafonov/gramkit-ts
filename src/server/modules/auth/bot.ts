/**
 * `/start auth_<token>`: web login through the bot.
 *
 * The web gets `bot_url` from `POST /auth/login/telegram/deeplink/start` and polls `.../deeplink/poll`. The user opens
 * the link and the bot asks them to confirm, showing where and when the login was asked for; the button creates the
 * session and marks the token verified, and the next poll logs the browser in.
 *
 * Python logs in on the `/start` itself. Anyone can make a link, so a victim tricked into opening one ("tap Start to
 * claim your gift") handed their session to whoever polls it. The button and what it shows are the check.
 *
 * Only in a private chat, and the button works only for whoever opened the link: in a group the button would be
 * pressed by another member, and the session built from the presser would go to whoever started the link.
 */
import { isIP } from 'node:net';
import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../../bot/context';
import { UserType } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import { esc } from '../messages/admin-messages';

const logger = getLogger('bot-auth');

const AUTH_PREFIX = 'auth_';
/** The confirm button's callback data: `auth_ok:<token>` (51 bytes for a real token, under Telegram's 64). */
export const AUTH_CONFIRM_PREFIX = 'auth_ok:';

export const authComposer = new Composer<BotContext>();

const EXPIRED = 'This login link has expired.\n\nPlease go back to the website and try again.';
const USED = 'This login link has already been used.\n\nPlease go back to the website and try again.';
const NOT_YOURS = 'This login button is not for you.\n\nOpen the login link from the website yourself.';

/** Where the login was asked for, as the confirmation shows it: only a real IP (the header is the client's to set). */
function requestedFrom(ip: string | undefined, createdAt: string | undefined): string {
  const shownIp = ip && isIP(ip) ? ip : 'an unknown address';
  const when = createdAt ? new Date(createdAt) : null;
  const shownTime = when && !Number.isNaN(when.getTime()) ? ` at ${when.toISOString().slice(11, 16)} UTC` : '';
  return `${shownIp}${shownTime}`;
}

authComposer.on('message').command('start', async (ctx, next) => {
  if (!ctx.match.startsWith(AUTH_PREFIX)) return next();

  if (ctx.chat.type !== 'private') {
    // No button where someone else could press it, and no reply to point a group at the bot
    logger.warn(`Auth link opened outside a private chat: chat_type=${ctx.chat.type}, telegram_id=${ctx.from.id}`);
    return;
  }

  const token = ctx.match.slice(AUTH_PREFIX.length);
  if (!token) {
    await ctx.reply('Invalid authentication link.');
    return;
  }
  const preview = `${token.slice(0, 8)}...`;
  logger.info(`Auth attempt: token=${preview}, telegram_id=${ctx.from.id}`);

  const tokenData = await ctx.services.auth.getLinkStatus(token);
  if (!tokenData) {
    logger.warn(`Auth token not found or expired: ${preview}`);
    await ctx.reply(EXPIRED);
    return;
  }
  if (tokenData.status !== 'pending') {
    logger.warn(`Auth token not pending: ${preview}, status=${tokenData.status}`);
    await ctx.reply(USED);
    return;
  }

  await ctx.services.auth.bindLinkSender(token, ctx.from.id);
  await ctx.reply(
    'Log in to the website with this Telegram account?\n\n' +
      `The login was requested from ${esc(requestedFrom(tokenData.ip, tokenData.created_at))}.\n\n` +
      "If it wasn't you, ignore this message: without the button nobody gets in.",
    { reply_markup: new InlineKeyboard().text('Log in', `${AUTH_CONFIRM_PREFIX}${token}`) },
  );
});

authComposer.callbackQuery(/^auth_ok:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { services } = ctx;

  const token = ctx.match[1] ?? '';
  const preview = `${token.slice(0, 8)}...`;
  const tgUser = ctx.from;
  logger.info(`Auth confirmed: token=${preview}, telegram_id=${tgUser.id}`);

  const tokenData = await services.auth.getLinkStatus(token);
  if (!tokenData) {
    logger.warn(`Auth token not found or expired: ${preview}`);
    await ctx.reply(EXPIRED);
    return;
  }
  if (tokenData.status !== 'pending') {
    logger.warn(`Auth token not pending: ${preview}, status=${tokenData.status}`);
    await ctx.reply(USED);
    return;
  }
  // The session is built from the presser: they must be who opened the link, in their own chat with the bot
  if (ctx.chat?.type !== 'private' || !(await services.auth.isLinkSender(token, tgUser.id))) {
    logger.warn(`Auth button pressed by someone else: token=${preview}, telegram_id=${tgUser.id}`);
    await ctx.reply(NOT_YOURS);
    return;
  }

  const dbUser = await services.users.getOrCreateUser({
    telegramId: tgUser.id,
    // App profile fields (populated from TG data on first login)
    displayName: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || tgUser.username || 'User',
    username: tgUser.username ?? null,
    languageCode: tgUser.language_code ?? null,
    // Telegram data (read-only from the TG API)
    tgFirstName: tgUser.first_name || 'User',
    tgLastName: tgUser.last_name ?? null,
    tgUsername: tgUser.username ?? null,
    tgLanguageCode: tgUser.language_code ?? null,
    tgIsBot: tgUser.is_bot,
    tgIsPremium: tgUser.is_premium ?? null,
    userType: UserType.REGISTERED,
  });

  logger.info(`Auth user: telegram_id=${tgUser.id}, db_user_id=${dbUser.id}`);

  const sessionId = await services.sessions.createSession(dbUser.id, dbUser.userType, {
    auth_method: 'telegram_link',
    telegram_id: tgUser.id,
  });

  logger.info(`Auth session created: session_id=${sessionId}, user_id=${dbUser.id}`);

  if (!(await services.auth.verifyLinkToken(token, dbUser.id, sessionId))) {
    logger.error(`Failed to verify link token: ${preview}`);
    await ctx.reply('Authentication failed.\n\nPlease go back to the website and try again.');
    return;
  }

  logger.info(`Auth completed: token=${preview}, user_id=${dbUser.id}`);

  await ctx.reply('Login successful!\n\nYou can now return to the website. Your session has been activated.');
});
