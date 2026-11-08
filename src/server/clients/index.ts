/**
 * Process-wide clients: created lazily, once, and closed at shutdown. A request never builds its own; it reads them
 * from `Clients` (`c.var.state.clients`), so tests can hand the app fakes instead.
 */
import type { Bot } from 'grammy';
import { getLogger } from '../lib/logging';
import { getBot } from './bot';
import { posthog } from './posthog';
import { QueueClient } from './queue';
import { RabbitProducer } from './rabbit';
import { RedisClient } from './redis';
import { closeSentry } from './sentry';

const logger = getLogger('clients');

export interface Clients {
  bot: Bot | null;
  queue: QueueClient;
  redis: RedisClient;
  producer: RabbitProducer;
}

let clients: Clients | undefined;

export function getClients(): Clients {
  clients ??= { bot: getBot(), queue: new QueueClient(), redis: new RedisClient(), producer: new RabbitProducer() };
  return clients;
}

async function closeQuietly(name: string, close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (err) {
    logger.warn({ err }, `${name} close failed`);
  }
}

/** Close what was opened. grammY keeps no connection, so a bot needs no closing. */
export async function closeClients(): Promise<void> {
  const current = clients;
  clients = undefined;
  if (current) {
    await closeQuietly('queue', () => current.queue.close());
    await closeQuietly('rabbit', () => current.producer.close());
    await closeQuietly('redis', () => current.redis.close());
  }
  await closeQuietly('posthog', () => posthog.close());
  await closeQuietly('sentry', closeSentry);
}

export { getBot, getSharedBot } from './bot';
export { posthog } from './posthog';
export type { EnqueueOptions } from './queue';
export { QUEUE_NAME, QueueClient, queueConnection } from './queue';
export { RabbitProducer } from './rabbit';
export { RedisClient } from './redis';
