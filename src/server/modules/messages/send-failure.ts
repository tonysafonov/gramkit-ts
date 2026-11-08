import { supportedLocale } from '../../lib/i18n';
import type { UserSchema } from '../users/schemas';

/**
 * The result of a failed Telegram send (see `MessagesService.guard`). A send returns `true` or one of these, so
 * `result === true` says delivered and `result.errorCode` says why it wasn't. Python's `SendFailure` is falsy; here
 * the check is explicit.
 */
export class SendFailure {
  static readonly FORBIDDEN = 'forbidden'; // blocked the bot / deactivated account
  static readonly BAD_REQUEST = 'bad_request'; // chat not found, bad markup, ...
  static readonly OTHER = 'other'; // any other Telegram API error (or an unexpected exception)

  constructor(readonly errorCode: string) {}
}

export type SendResult = true | SendFailure;

/** The language a bot message to `user` goes out in (one we have copy for, else English). */
export function userLanguage(user: Pick<UserSchema, 'languageCode' | 'tgLanguageCode'>): string {
  return supportedLocale(user.languageCode || user.tgLanguageCode);
}

/** `null` for a successful send result, else the failure's error code. */
export function sendErrorCode(result: SendResult): string | null {
  return result === true ? null : result.errorCode;
}
