/** `/auth/link/telegram`: web users link their Telegram account. */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { AppError } from '../../lib/errors';
import { validate } from '../../lib/validate';
import { requireUserId } from '../auth/routes';
import {
  type TelegramLinkErrorCode,
  TelegramLinkException,
  TelegramLinkPollQuery,
  toTelegramLinkStatusResponse,
} from './schemas';

const ERRORS: Record<TelegramLinkErrorCode, [ContentfulStatusCode, string]> = {
  rate_limited: [429, 'Too many requests. Please try again later.'],
  already_linked: [409, 'Telegram account already linked to this account.'],
  token_invalid: [400, 'Invalid or expired link token.'],
  token_expired: [410, 'Link token expired. Please start again.'],
  telegram_already_used: [409, 'This Telegram account is already linked to another user.'],
  user_not_found: [404, 'User not found.'],
};

export const telegramLinkRoutes = new Hono<Env>()
  .post('/start', getUser, async (c) => {
    const userId = requireUserId(c);
    try {
      const result = await c.var.services.telegramLink.startLink(userId);
      return c.json({ link_token: result.linkToken, bot_url: result.botUrl, expires_in: result.expiresIn });
    } catch (err) {
      if (!(err instanceof TelegramLinkException)) throw err;
      const [status, message] = ERRORS[err.errorCode];
      throw new AppError(status, { error: err.errorCode, message });
    }
  })
  .get('/poll', getUser, validate('query', TelegramLinkPollQuery), async (c) => {
    requireUserId(c);
    const result = await c.var.services.telegramLink.getStatus(c.req.valid('query').token);
    if (!result) return c.json({ status: 'expired', telegram_id: null, telegram_username: null, error: null });
    return c.json(toTelegramLinkStatusResponse(result));
  });
