/**
 * Sessions in Redis, shared by the bot and the API. The JSON stays snake_case: it is the stored format, the Python
 * app's.
 */
import { randomUUID } from 'node:crypto';
import type { RedisClient } from '../../clients/redis';
import { settings } from '../../config';
import { isInfrastructureError } from '../../lib/infra-errors';
import { getLogger } from '../../lib/logging';

const logger = getLogger('sessions');

export interface SessionData {
  user_id: string;
  user_type: string;
  created_at: string;
  last_accessed: string;
  [metadata: string]: unknown;
}

const sessionKey = (sessionId: string): string => `${settings.session.keyPrefix}${sessionId}`;
/** When the user's sessions were last revoked: older ones are void. Never a session id, which is a UUID. */
const validAfterKey = (userId: string): string => `${settings.session.keyPrefix}valid_after:${userId}`;
const expireSeconds = (): number => settings.session.expireDays * 24 * 60 * 60;
/** A day past the longest a session can go unused: by then every session older than the cutoff was refused or expired. */
const VALID_AFTER_MARGIN_SECONDS = 24 * 60 * 60;

export class SessionsService {
  constructor(protected readonly redis: RedisClient) {}

  /** Store a new session with its TTL and return its id. */
  async createSession(userId: string, userType: string, metadata?: Record<string, unknown> | null): Promise<string> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const sessionData: SessionData = {
      user_id: userId,
      user_type: userType,
      created_at: now,
      last_accessed: now,
      ...metadata,
    };

    await this.redis.set(sessionKey(sessionId), JSON.stringify(sessionData), expireSeconds());

    logger.info(`Created session ${sessionId} for user ${userId} with prefix ${settings.session.keyPrefix}`);
    return sessionId;
  }

  /**
   * The session's data with `last_accessed` updated and the TTL extended, `null` when it is invalid or expired.
   *
   * Redis and network errors are rethrown: an unreachable Redis is not "no session", so auth answers 503 instead of
   * handing a logged-in user the guest.
   */
  async validateSession(sessionId: string): Promise<SessionData | null> {
    if (!sessionId) return null;

    const key = sessionKey(sessionId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const sessionData = JSON.parse(raw) as SessionData;
      if (await this.isRevoked(sessionData)) {
        await this.redis.delete(key);
        logger.info(`Session ${sessionId} was revoked for user ${sessionData.user_id}`);
        return null;
      }
      sessionData.last_accessed = new Date().toISOString();
      await this.redis.set(key, JSON.stringify(sessionData), expireSeconds());
      return sessionData;
    } catch (err) {
      if (isInfrastructureError(err)) throw err;
      logger.warn({ err }, `Invalid session data for ${sessionId}`);
      return null;
    }
  }

  /**
   * Void every session of the user that exists now (a password reset: a stolen session must not outlive it). Sessions
   * live only in Redis, keyed by id, so this stores a cutoff that `validateSession` checks. Python has no such thing.
   */
  async revokeUserSessions(userId: string): Promise<void> {
    await this.redis.set(validAfterKey(userId), new Date().toISOString(), expireSeconds() + VALID_AFTER_MARGIN_SECONDS);
    logger.info(`Revoked the sessions of user ${userId}`);
  }

  /** Created before the user's sessions were revoked (an unreadable `created_at` counts as before). */
  private async isRevoked(sessionData: SessionData): Promise<boolean> {
    if (!sessionData.user_id) return false;
    const validAfter = await this.redis.get(validAfterKey(sessionData.user_id));
    if (!validAfter) return false;
    return !(Date.parse(sessionData.created_at) >= Date.parse(validAfter));
  }

  /** `true` when the session was there, `false` when it wasn't or Redis failed. */
  async destroySession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;

    try {
      const deleted = await this.redis.delete(sessionKey(sessionId));
      logger.info(`Destroyed session ${sessionId}`);
      return deleted > 0;
    } catch (err) {
      logger.error({ err }, `Error destroying session ${sessionId}`);
      return false;
    }
  }
}
