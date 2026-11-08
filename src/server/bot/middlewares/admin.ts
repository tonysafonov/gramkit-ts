import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../context';

/**
 * Lets only owners through: the user's Telegram id must be in `ownerIds`. Others get `unauthorizedMsg` (an alert on a
 * callback query) and the handler does not run. Needs `authMiddleware` before it.
 */
export function adminMiddleware(
  ownerIds: readonly number[] | (() => readonly number[]),
  unauthorizedMsg = "You don't have permission to use this command",
): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const telegramId = ctx.user?.telegramId;
    if (telegramId && (typeof ownerIds === 'function' ? ownerIds() : ownerIds).includes(telegramId)) return next();

    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: unauthorizedMsg, show_alert: true });
    else if (ctx.message) await ctx.reply(unauthorizedMsg);
  };
}
