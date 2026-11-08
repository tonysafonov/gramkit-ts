import type { MiddlewareFn } from 'grammy';
import { i18n } from '../../lib/i18n';
import { runWithRequestContext } from '../../lib/request-context';
import type { BotContext } from '../context';

/**
 * Gives the update its own request context (the id in every log line, the locale `i18n()` reads) and sets the
 * locale from the authenticated user. The context ends with the update, so there is nothing to reset.
 */
export function i18nMiddleware(): MiddlewareFn<BotContext> {
  return (ctx, next) =>
    runWithRequestContext({ requestId: `tg-${ctx.update.update_id}` }, () => {
      i18n.setUserLocale(ctx.user);
      return next();
    });
}
