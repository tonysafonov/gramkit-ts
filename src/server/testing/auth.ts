/** Auth helpers: signed initData, and a shortcut that authenticates a test request as a given user. */
import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { generateSecretKey } from '../auth/telegram';
import { setSentryUser } from '../clients/sentry';
import { settings } from '../config';
import type { User } from '../db/schema';
import type { UserEnv } from '../env';
import { i18n } from '../lib/i18n';
import { AuthService } from '../modules/auth/service';
import type { UserSchema } from '../modules/users/schemas';
import { Services } from '../services';

export const TEST_USER_HEADER = 'x-test-user-id';

/** Headers that make `TestServices` resolve the request's user to this row, without going through real auth. */
export const asUser = (user: Pick<User, 'id'>): Record<string, string> => ({ [TEST_USER_HEADER]: user.id });

class TestAuthService extends AuthService {
  override async resolveUser(c: Context<UserEnv>): Promise<UserSchema> {
    const id = c.req.header(TEST_USER_HEADER);
    if (!id) return super.resolveUser(c);
    const user = await this.repos.users.getById(id);
    if (!user) throw new Error(`Test user ${id} does not exist`);
    i18n.setUserLocale(user);
    setSentryUser({ userId: user.id, username: user.username, email: user.email, tgUsername: user.tgUsername });
    return user;
  }
}

/** The app's `Services` with `asUser` support: a request without the header goes through the real `resolveUser`. */
export class TestServices extends Services {
  #auth?: TestAuthService;

  override get auth(): AuthService {
    return (this.#auth ??= new TestAuthService(this.repos, this.producer, this, this.bot));
  }
}

interface InitDataOptions {
  userId: number;
  username: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isPremium?: boolean;
  authDate?: number;
  botToken?: string;
}

/** Telegram Mini App initData, signed so `TelegramAuthenticator.verifyToken` accepts it. For the `initData` header. */
export function generateTelegramInitData({
  userId,
  username,
  firstName = 'Test',
  lastName,
  languageCode = 'en',
  isPremium = false,
  authDate = Math.floor(Date.now() / 1000),
  botToken = settings.bot.token,
}: InitDataOptions): string {
  const user = JSON.stringify({
    id: userId,
    first_name: firstName,
    username,
    language_code: languageCode,
    is_premium: isPremium,
    ...(lastName ? { last_name: lastName } : {}),
  });
  const dataCheckString = [`auth_date=${authDate}`, `user=${user}`].sort().join('\n');
  const hash = createHmac('sha256', generateSecretKey(botToken)).update(dataCheckString).digest('hex');
  return new URLSearchParams({ user, auth_date: String(authDate), hash }).toString();
}
