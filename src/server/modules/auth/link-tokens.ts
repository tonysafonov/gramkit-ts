import { randomBytes } from 'node:crypto';
import type { RedisClient } from '../../clients/redis';
import { getLogger } from '../../lib/logging';

const logger = getLogger('auth');

const LINK_TOKEN_PREFIX = 'web_auth:';
const LINK_TOKEN_TTL = 300;
/** How long a verified token waits for the web to poll it. */
const VERIFIED_TOKEN_TTL = 60;

export interface LinkTokenData {
  status: string;
  created_at: string;
  ip: string;
  user_id?: string;
  session_id?: string;
  verified_at?: string;
}

const tokenKey = (token: string): string => `${LINK_TOKEN_PREFIX}${token}`;
/** Who opened the link (the `/start` sender): only they may press its button. */
const senderKey = (token: string): string => `${LINK_TOKEN_PREFIX}sender:${token}`;
const preview = (token: string): string => `${token.slice(0, 8)}...`;

/**
 * Deep link login tokens: the web creates one, the bot verifies it, the web polls and consumes it. Redis only, so the
 * web's routes use it without opening a transaction; `services.auth` exposes the same methods.
 */
export class DeepLinkTokens {
  constructor(private readonly redis: RedisClient) {}

  async createLinkToken(ip?: string | null): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const tokenData: LinkTokenData = { status: 'pending', created_at: new Date().toISOString(), ip: ip || 'unknown' };

    await this.redis.set(tokenKey(token), JSON.stringify(tokenData), LINK_TOKEN_TTL);

    logger.info(`Link auth token created: ${preview(token)}`);
    return token;
  }

  /** The token's data, `null` when it expired or never existed. */
  async getLinkStatus(token: string): Promise<LinkTokenData | null> {
    const data = await this.redis.get(tokenKey(token));
    return data ? (JSON.parse(data) as LinkTokenData) : null;
  }

  /** Record who opened the link in the bot; the confirm button then works only for them. */
  async bindSender(token: string, telegramId: number): Promise<void> {
    await this.redis.set(senderKey(token), String(telegramId), LINK_TOKEN_TTL);
  }

  /** Whether `telegramId` is who opened the link. `false` when nobody did. */
  async isSender(token: string, telegramId: number): Promise<boolean> {
    return (await this.redis.get(senderKey(token))) === String(telegramId);
  }

  /** Mark a pending token as verified, with the session the web will pick up. `false` when it wasn't pending. */
  async verifyLinkToken(token: string, userId: string, sessionId: string): Promise<boolean> {
    const tokenData = await this.getLinkStatus(token);

    if (!tokenData) {
      logger.warn(`Token not found for verification: ${preview(token)}`);
      return false;
    }
    if (tokenData.status !== 'pending') {
      logger.warn(`Token not pending: ${preview(token)}, status=${tokenData.status}`);
      return false;
    }

    const verified: LinkTokenData = {
      ...tokenData,
      status: 'verified',
      user_id: userId,
      session_id: sessionId,
      verified_at: new Date().toISOString(),
    };
    await this.redis.set(tokenKey(token), JSON.stringify(verified), VERIFIED_TOKEN_TTL);

    logger.info(`Link auth token verified: ${preview(token)}, user_id=${userId}`);
    return true;
  }

  /** Get and delete a verified token (single use). `null` for any other token. */
  async consumeLinkToken(token: string): Promise<LinkTokenData | null> {
    const tokenData = await this.getLinkStatus(token);
    if (tokenData?.status !== 'verified') return null;
    await this.redis.delete(tokenKey(token));
    return tokenData;
  }
}
