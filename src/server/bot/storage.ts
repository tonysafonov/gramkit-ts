import type { StorageAdapter } from 'grammy';
import type { RedisClient } from '../clients';
import { settings } from '../config';
import type { BotSession } from './context';

/**
 * FSM storage in Redis, aiogram's `RedisStorage` with `DefaultKeyBuilder(with_bot_id=True)`: one JSON value per
 * bot + chat + user, with no expiry (a flow waits for the admin as long as it takes).
 */
export class RedisSessionStorage implements StorageAdapter<BotSession> {
  constructor(
    private readonly redis: RedisClient,
    private readonly botId: string,
  ) {}

  private redisKey(key: string): string {
    return `${settings.appName}:fsm:${this.botId}:${key}`;
  }

  async read(key: string): Promise<BotSession | undefined> {
    const raw = await this.redis.get(this.redisKey(key));
    return raw === null ? undefined : (JSON.parse(raw) as BotSession);
  }

  async write(key: string, value: BotSession): Promise<void> {
    await this.redis.set(this.redisKey(key), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.redis.delete(this.redisKey(key));
  }
}
