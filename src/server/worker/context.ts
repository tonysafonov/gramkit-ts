/**
 * What a job gets: Python's `WorkerContext`. Granular transaction control, so a job never holds a connection while it
 * waits on Telegram or a payment provider.
 *
 *     await ctx.withTransaction((services) => services.users.doSomething());   // atomic DB work
 *     await ctx.bot.api.sendMessage(...);                                      // external call, no transaction
 *
 * One context per job run (it carries the queue's job id and the abort signal); the clients are the process's.
 */
import type { Bot } from 'grammy';
import type { QueueClient } from '../clients/queue';
import type { RabbitProducer } from '../clients/rabbit';
import type { RedisClient } from '../clients/redis';
import type { Database } from '../db/client';
import { Repos } from '../repos';
import { Services } from '../services';

/** The process-wide things every job run shares. */
export interface WorkerResources {
  db: Database;
  bot: Bot;
  redis: RedisClient;
  queue: QueueClient;
  producer: RabbitProducer;
}

export class WorkerContext {
  constructor(
    private readonly resources: WorkerResources,
    /** The queue's job id (BullMQ's), `null` outside a queue. */
    readonly jobId: string | null = null,
    /** Aborted when the job times out or the worker shuts down. */
    readonly signal: AbortSignal = new AbortController().signal,
  ) {}

  get bot(): Bot {
    return this.resources.bot;
  }

  get redis(): RedisClient {
    return this.resources.redis;
  }

  get queue(): QueueClient {
    return this.resources.queue;
  }

  get producer(): RabbitProducer {
    return this.resources.producer;
  }

  private servicesOn(db: ConstructorParameters<typeof Repos>[0]): Services {
    const { bot, producer, redis, queue } = this.resources;
    return new Services(new Repos(db), producer, bot, redis, queue);
  }

  /** Services inside one transaction: it commits when `fn` returns and rolls back when it throws. */
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T> {
    return this.resources.db.transaction((tx) => fn(this.servicesOn(tx)));
  }

  /**
   * Services on the pool with NO transaction: for a phase that only calls external APIs between two short
   * transactions. Don't write through them; a write opens its own short transaction (`MessagesService` does, to flag a
   * user who blocked the bot).
   */
  withoutTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T> {
    return fn(this.servicesOn(this.resources.db));
  }

  /** Repos on the pool with no transaction: read-only queries. */
  withRepo<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
    return fn(new Repos(this.resources.db));
  }
}
