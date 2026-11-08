import { z } from 'zod';
import { BackendException } from '../../lib/errors';

/** What linking raises, Python's `ValueError("<code>")`. The route and the bot handler translate it. */
export type TelegramLinkErrorCode =
  | 'rate_limited'
  | 'already_linked'
  | 'token_invalid'
  | 'token_expired'
  | 'telegram_already_used'
  | 'user_not_found';

export class TelegramLinkException extends BackendException {
  constructor(readonly errorCode: TelegramLinkErrorCode) {
    super(errorCode);
  }
}

export const TelegramLinkPollQuery = z.object({ token: z.string() });

/** The Telegram side of a user. */
export interface TelegramUserData {
  tgFirstName: string;
  tgLastName: string | null;
  tgUsername: string | null;
  tgLanguageCode: string | null;
  tgIsBot: boolean | null;
  tgIsPremium: boolean | null;
}

export interface TelegramLinkStatus {
  status: string;
  telegramId: number | null;
  telegramUsername: string | null;
  error: string | null;
}

export const toTelegramLinkStatusResponse = (status: TelegramLinkStatus) => ({
  status: status.status,
  telegram_id: status.telegramId,
  telegram_username: status.telegramUsername,
  error: status.error,
});
