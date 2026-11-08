/** Scripts: one-off jobs run from the CLI with the same infrastructure as the server. Port of `core/scripts/base.py`. */
import type { Bot } from 'grammy';
import type { QueueClient } from '../clients/queue';
import type { RabbitProducer } from '../clients/rabbit';
import type { RedisClient } from '../clients/redis';
import type { DbConfig } from '../config';
import type { Database } from '../db/client';
import { getLogger } from '../lib/logging';
import { Repos } from '../repos';
import { Services } from '../services';

/** What the runner hands a script: every long-lived client, the pool, and the app's name. */
export interface ScriptContext {
  appName: string;
  dbConfig: DbConfig;
  db: Database;
  /** `null` when no bot token is configured. */
  bot: Bot | null;
  redis: RedisClient;
  producer: RabbitProducer;
  queue: QueueClient;
}

/** What the runner needs from a script. */
export interface Script {
  execute(...args: string[]): Promise<unknown>;
}

/**
 * A script with the full infrastructure. Implement `run`; `execute` adds setup, teardown and the log lines.
 *
 *     class MyScript extends BaseScript {
 *       async run() { return this.withServices((services) => services.users.getUsersCount()); }
 *     }
 */
export abstract class BaseScript implements Script {
  protected readonly logger = getLogger(this.constructor.name);

  constructor(protected readonly ctx: ScriptContext) {}

  /** Services on the pool with no transaction: for reads. A write that must be atomic opens its own transaction. */
  withServices<T>(fn: (services: Services) => Promise<T>): Promise<T> {
    const { db, producer, bot, redis, queue } = this.ctx;
    return fn(new Services(new Repos(db), producer, bot, redis, queue));
  }

  /** Services inside one transaction: commits when `fn` returns, rolls back when it throws. */
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T> {
    const { db, producer, bot, redis, queue } = this.ctx;
    return db.transaction((tx) => fn(new Services(new Repos(tx), producer, bot, redis, queue)));
  }

  withRepo<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
    return fn(new Repos(this.ctx.db));
  }

  abstract run(...args: string[]): Promise<unknown>;

  async setup(): Promise<void> {}

  async teardown(): Promise<void> {}

  async execute(...args: string[]): Promise<unknown> {
    const name = this.constructor.name;
    try {
      await this.setup();
      this.logger.info(`Starting script: ${name}`);
      const result = await this.run(...args);
      this.logger.info(`Script completed: ${name}`);
      return result;
    } catch (err) {
      this.logger.error({ err }, `Script failed: ${name}`);
      throw err;
    } finally {
      await this.teardown();
    }
  }
}
