/**
 * Telegram Mini App authentication: HMAC validation of initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const webAppUser = z.strictObject({
  id: z.number().int(),
  first_name: z.string(),
  is_bot: z.boolean().nullish(),
  last_name: z.string().nullish(),
  username: z.string().nullish(),
  language_code: z.string().nullish(),
  is_premium: z.boolean().nullish(),
  added_to_attachment_menu: z.boolean().nullish(),
  allows_write_to_pm: z.boolean().nullish(),
  photo_url: z.string().nullish(),
});

export interface TelegramUser {
  id: number;
  firstName: string;
  isBot?: boolean | null;
  lastName?: string | null;
  username?: string | null;
  languageCode?: string | null;
  isPremium?: boolean | null;
  addedToAttachmentMenu?: boolean | null;
  allowsWriteToPm?: boolean | null;
  photoUrl?: string | null;
}

/** initData is missing from the request. */
export class NoInitDataError extends Error {}

/** initData failed validation. */
export class InvalidInitDataError extends Error {}

/** The secret for validating initData: HMAC-SHA256 of the bot token, keyed with "WebAppData". */
export const generateSecretKey = (token: string): Buffer => createHmac('sha256', 'WebAppData').update(token).digest();

/** `urllib.parse.unquote`: a malformed escape stays as it is instead of raising. */
function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
      try {
        return decodeURIComponent(escaped);
      } catch {
        return escaped;
      }
    });
  }
}

/** `parse_qsl` into a dict: blank values dropped, the last duplicate wins. */
export function parseQs(data: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(data)) {
    if (value !== '') result[key] = value;
  }
  return result;
}

/** How far in the future an `auth_date` may be: the clocks of Telegram and of this server differ a little. */
const AUTH_DATE_SKEW_SECONDS = 300;

export class TelegramAuthenticator {
  /**
   * `maxAgeSeconds`: how long initData logs in from its `auth_date`, `0` for forever. Telegram's guide: check
   * `auth_date` to refuse outdated data. initData can't be revoked like a session, so without it one leaked string (a
   * log, a HAR file) is that user's account for good. Python checks nothing.
   */
  constructor(
    private readonly secret: Buffer,
    private readonly maxAgeSeconds = 86_400,
  ) {}

  /** Throws unless `auth_date` is a Unix time within the max age and not in the future. */
  private checkAuthDate(authDate: string | undefined): void {
    if (this.maxAgeSeconds <= 0) return;
    if (!authDate || !/^\d+$/.test(authDate)) throw new InvalidInitDataError('Init data has no valid auth_date');
    const age = Math.floor(Date.now() / 1000) - Number(authDate);
    if (age < -AUTH_DATE_SKEW_SECONDS) throw new InvalidInitDataError('Init data auth_date is in the future');
    if (age > this.maxAgeSeconds) throw new InvalidInitDataError('Init data is outdated');
  }

  private isValid(hash: string, token: string): boolean {
    const expected = Buffer.from(createHmac('sha256', this.secret).update(token).digest('hex'));
    const actual = Buffer.from(hash);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** The Telegram user signed into initData. Throws `InvalidInitDataError` for anything else. */
  verifyToken(token: string): TelegramUser {
    if (!token) throw new InvalidInitDataError('Init Data cannot be empty');
    const initData = parseQs(token);

    const dataCheckString = Object.entries(initData)
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const hash = initData.hash?.trim();
    if (!hash) throw new InvalidInitDataError('Init data does not contain hash');
    if (!this.isValid(hash, unquote(dataCheckString))) throw new InvalidInitDataError('Invalid token');
    this.checkAuthDate(initData.auth_date);

    const userData = initData.user;
    if (!userData) throw new InvalidInitDataError('Init data does not contain user');

    let parsed: unknown;
    try {
      parsed = JSON.parse(unquote(unquote(userData)));
    } catch {
      throw new InvalidInitDataError('Cannot decode init data');
    }
    const user = webAppUser.safeParse(parsed);
    if (!user.success) throw new InvalidInitDataError('Init data has an invalid user');

    const u = user.data;
    return {
      id: u.id,
      firstName: u.first_name,
      isBot: u.is_bot,
      lastName: u.last_name,
      username: u.username,
      languageCode: u.language_code,
      isPremium: u.is_premium,
      addedToAttachmentMenu: u.added_to_attachment_menu,
      allowsWriteToPm: u.allows_write_to_pm,
      photoUrl: u.photo_url,
    };
  }
}
