import type { Bot, MiddlewareFn } from 'grammy';
import type { QueueClient, RabbitProducer, RedisClient } from '../../clients';
import type { ServicesClass } from '../../env';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import type { BotContext } from '../context';

export interface ServiceDependencies {
  bot: Bot<BotContext>;
  producer: RabbitProducer;
  redis: RedisClient;
  queue: QueueClient;
}

/** The service aggregator of this update, built on its transaction's repos. */
export function servicesMiddleware(
  servicesClass: ServicesClass<Services, Repos>,
  { bot, producer, redis, queue }: ServiceDependencies,
): MiddlewareFn<BotContext> {
  return (ctx, next) => {
    ctx.services = new servicesClass(ctx.repos, producer, bot as unknown as Bot, redis, queue);
    return next();
  };
}
