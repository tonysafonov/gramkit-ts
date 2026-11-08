import type { MiddlewareFn } from 'grammy';
import type { Update } from 'grammy/types';
import { type NewUser, UserType } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import type { BotContext } from '../context';

const logger = getLogger('bot-auth');

/** Deep link prefixes that skip user creation: those handlers do their own user lookup/creation. */
const SKIP_USER_CREATION_PREFIXES = ['link_'];
/** Callback data that skips it too: the telegram-link confirmation button (`link_ok:<token>`). */
const SKIP_USER_CREATION_CALLBACKS = ['link_ok:'];

/**
 * `/start link_<token>` and its confirmation button: handled by the telegram-link composer, which manages the user
 * itself (a row created here would make the link fail with `telegram_already_used`).
 */
export function shouldSkipUserCreation(update: Update): boolean {
  const data = update.callback_query?.data ?? '';
  if (SKIP_USER_CREATION_CALLBACKS.some((prefix) => data.startsWith(prefix))) return true;
  const text = update.message?.text ?? '';
  if (!text.startsWith('/start ')) return false;
  const args = text.slice('/start '.length);
  return SKIP_USER_CREATION_PREFIXES.some((prefix) => args.startsWith(prefix));
}

/**
 * Whether this update should CREATE a user (vs. just be observed).
 *
 * Only genuine interactions where the bot has a private chat it can reply in may create a user: a private-chat
 * message, a callback query, or a payment query. Membership and observation updates (`my_chat_member`,
 * `chat_member`, `chat_join_request`, `message_reaction`, `poll_answer`, ...) merely reference a user the bot *sees*:
 * persisting those mints "ghost" users who never engaged and cannot be messaged (Telegram forbids bot-initiated
 * DMs), polluting user counts and DAU/MAU.
 */
export function isUserCreatingEvent(update: Update): boolean {
  const message = update.message ?? update.edited_message;
  if (message) return message.chat.type === 'private';
  return Boolean(update.callback_query ?? update.pre_checkout_query ?? update.shipping_query);
}

const updateLabel = (update: Update): string => Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';

/**
 * Authenticates the Telegram user of the update: `services.users.getOrCreateUser`, the result on `ctx.user`.
 * Needs `servicesMiddleware` before it.
 */
export function authMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (shouldSkipUserCreation(ctx.update)) return next();

    if (!isUserCreatingEvent(ctx.update)) {
      logger.debug(`AuthMiddleware: skipping user creation for non-interaction update '${updateLabel(ctx.update)}'`);
      return next();
    }

    const tgUser = ctx.from;
    if (!tgUser) return next();

    const displayName = `${tgUser.first_name ?? ''} ${tgUser.last_name ?? ''}`.trim() || tgUser.username || 'User';
    const userData: NewUser = {
      telegramId: tgUser.id,
      // App profile fields (populated from TG data on first login)
      displayName,
      username: tgUser.username,
      languageCode: tgUser.language_code,
      // Telegram data (read-only from TG API)
      tgFirstName: tgUser.first_name,
      tgLastName: tgUser.last_name,
      tgUsername: tgUser.username,
      tgLanguageCode: tgUser.language_code,
      tgIsBot: tgUser.is_bot,
      tgIsPremium: tgUser.is_premium,
      userType: UserType.REGISTERED,
    };

    ctx.user = await ctx.services.users.getOrCreateUser(userData);
    return next();
  };
}
