/**
 * Link a Telegram account to a web user (email auth).
 *
 * The user calls `startLink` and opens the bot with `t.me/bot?start=link_<token>`, the bot asks them to confirm and
 * calls `completeLink`, and the web polls `getStatus` until it is done.
 */
import { randomBytes } from 'node:crypto';
import type { RedisClient } from '../../clients/redis';
import { getLogger } from '../../lib/logging';
import type { UsersRepo } from '../users/repo';
import { TelegramLinkException, type TelegramLinkStatus, type TelegramUserData } from './schemas';

const logger = getLogger('telegram-link');

const redisKeys = {
  linkToken: (token: string) => `telegram_link:${token}`,
  rateLimit: (userId: string) => `telegram_link:rate:${userId}`,
  /** Who opened the link (the `/start` sender): only they may press its button. */
  sender: (token: string) => `telegram_link:sender:${token}`,
};

const LINK_TOKEN_TTL = 300;
const RATE_LIMIT_WINDOW = 900;
/** Link attempts per user. */
export const RATE_LIMIT_MAX = 5;
/** How long a finished token stays readable, so the web's poll sees the outcome. */
const FINISHED_TOKEN_TTL = 60;

interface TokenData {
  user_id: string;
  status: string;
  created_at: string;
  telegram_id?: number;
  telegram_username?: string | null;
  completed_at?: string;
  error?: string;
}

export class TelegramLinkService {
  constructor(
    protected readonly redis: RedisClient,
    protected readonly userRepo: UsersRepo,
    protected readonly botUrl: string,
  ) {}

  /** Make a link token and the bot's deep link for it. */
  async startLink(userId: string): Promise<{ linkToken: string; botUrl: string; expiresIn: number }> {
    if (!(await this.checkRateLimit(userId))) throw new TelegramLinkException('rate_limited');

    const user = await this.userRepo.getById(userId);
    if (!user) throw new TelegramLinkException('user_not_found');
    if (user.telegramId !== null) throw new TelegramLinkException('already_linked');

    const linkToken = randomBytes(32).toString('base64url');
    const tokenData: TokenData = { user_id: userId, status: 'pending', created_at: new Date().toISOString() };

    await this.redis.set(redisKeys.linkToken(linkToken), JSON.stringify(tokenData), LINK_TOKEN_TTL);
    await this.incrementRateLimit(userId);

    logger.info(`Telegram link started for user_id=${userId}`);

    return { linkToken, botUrl: `${this.botUrl}?start=link_${linkToken}`, expiresIn: LINK_TOKEN_TTL };
  }

  /** The user a pending token would link to, for the bot's confirmation; `null` for any other token. */
  async getPendingUserId(token: string): Promise<string | null> {
    const raw = await this.redis.get(redisKeys.linkToken(token));
    if (!raw) return null;
    const tokenData = JSON.parse(raw) as TokenData;
    return tokenData.status === 'pending' ? tokenData.user_id : null;
  }

  /** Record who opened the link in the bot; the confirm button then works only for them. */
  async bindSender(token: string, telegramId: number): Promise<void> {
    await this.redis.set(redisKeys.sender(token), String(telegramId), LINK_TOKEN_TTL);
  }

  /** Whether `telegramId` is who opened the link. `false` when nobody did. */
  async isSender(token: string, telegramId: number): Promise<boolean> {
    return (await this.redis.get(redisKeys.sender(token))) === String(telegramId);
  }

  /** Called by the bot once the user confirms: put the Telegram data on the user of the token. */
  async completeLink(
    token: string,
    telegramId: number,
    telegramUserData: TelegramUserData,
  ): Promise<{ userId: string; success: true }> {
    const redisKey = redisKeys.linkToken(token);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new TelegramLinkException('token_invalid');

    const tokenData = JSON.parse(raw) as TokenData;
    if (tokenData.status !== 'pending') throw new TelegramLinkException('token_invalid');

    const userId = tokenData.user_id;

    const existingUser = await this.userRepo.getByTelegramId(telegramId);
    if (existingUser && existingUser.id !== userId) {
      await this.setErrorStatus(token, redisKey, tokenData, 'telegram_already_used');
      throw new TelegramLinkException('telegram_already_used');
    }

    const user = await this.userRepo.getById(userId);
    if (!user) {
      await this.redis.delete(redisKey);
      throw new TelegramLinkException('user_not_found');
    }

    const { tgFirstName, tgLastName, tgUsername, tgLanguageCode, tgIsBot, tgIsPremium } = telegramUserData;
    await this.userRepo.updateUser(userId, {
      telegramId,
      tgFirstName,
      tgLastName,
      tgUsername,
      tgLanguageCode,
      tgIsPremium,
      tgIsBot,
      // The app profile keeps what the user set
      languageCode: user.languageCode || tgLanguageCode,
      displayName: user.displayName || `${tgFirstName} ${tgLastName ?? ''}`.trim() || tgUsername || 'User',
    });

    const completed: TokenData = {
      ...tokenData,
      status: 'completed',
      telegram_id: telegramId,
      telegram_username: tgUsername,
      completed_at: new Date().toISOString(),
    };
    await this.redis.set(redisKey, JSON.stringify(completed), FINISHED_TOKEN_TTL);

    logger.info(`Telegram linked for user_id=${userId}, telegram_id=${telegramId}`);

    return { userId, success: true };
  }

  /** The token's status for the web's polling, `null` when it expired or never existed. */
  async getStatus(token: string): Promise<TelegramLinkStatus | null> {
    const raw = await this.redis.get(redisKeys.linkToken(token));
    if (!raw) return null;

    const tokenData = JSON.parse(raw) as TokenData;
    return {
      status: tokenData.status ?? 'pending',
      telegramId: tokenData.telegram_id ?? null,
      telegramUsername: tokenData.telegram_username ?? null,
      error: tokenData.error ?? null,
    };
  }

  private async checkRateLimit(userId: string): Promise<boolean> {
    const count = await this.redis.get(redisKeys.rateLimit(userId));
    return !count || Number(count) < RATE_LIMIT_MAX;
  }

  private async incrementRateLimit(userId: string): Promise<void> {
    const key = redisKeys.rateLimit(userId);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, RATE_LIMIT_WINDOW);
  }

  /** Mark the token failed, so the web stops polling and can show why. */
  private async setErrorStatus(token: string, redisKey: string, tokenData: TokenData, error: string): Promise<void> {
    await this.redis.set(redisKey, JSON.stringify({ ...tokenData, status: 'error', error }), FINISHED_TOKEN_TTL);
    logger.info(`Link token status set to error: ${token.slice(0, 8)}..., error=${error}`);
  }
}
