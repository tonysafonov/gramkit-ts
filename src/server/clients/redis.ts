import { Redis } from 'ioredis';
import { settings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('redis');

/**
 * Redis as the services use it: strings in, strings out. One connection per process, opened on first use.
 *
 * `maxRetriesPerRequest` stays low so a command fails instead of hanging while Redis is down: in auth that failure is
 * what becomes a 503.
 */
export class RedisClient {
  private client: Redis | null = null;

  constructor(private readonly url: string = settings.redis.url) {}

  /** The underlying connection, for what the wrapper doesn't cover (pipelines, scans). */
  getClient(): Redis {
    if (!this.client) {
      this.client = new Redis(this.url, { maxRetriesPerRequest: 1, lazyConnect: false });
      this.client.on('error', (err: Error) => logger.warn({ err }, `Redis connection error: ${err.message}`));
    }
    return this.client;
  }

  get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  /** `ex`: TTL in seconds. */
  async set(key: string, value: string, ex?: number): Promise<boolean> {
    const result = ex ? await this.getClient().set(key, value, 'EX', ex) : await this.getClient().set(key, value);
    return result === 'OK';
  }

  /** Returns how many keys were deleted. */
  delete(key: string): Promise<number> {
    return this.getClient().del(key);
  }

  exists(key: string): Promise<number> {
    return this.getClient().exists(key);
  }

  incr(key: string): Promise<number> {
    return this.getClient().incr(key);
  }

  decr(key: string): Promise<number> {
    return this.getClient().decr(key);
  }

  /** Set a TTL in seconds. */
  async expire(key: string, seconds: number): Promise<boolean> {
    return (await this.getClient().expire(key, seconds)) === 1;
  }

  async flushdb(): Promise<boolean> {
    return (await this.getClient().flushdb()) === 'OK';
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.quit();
    } catch (err) {
      logger.error({ err }, 'Error closing Redis connection');
      client.disconnect();
    }
  }
}
