import type { Bot } from 'grammy';
import type { RabbitProducer } from '../clients/rabbit';
import type { Repos } from '../repos';
import type { Services } from '../services';

/** What every service gets: the request's repos, the process's clients, and the other services. */
export abstract class BaseService<R = Repos, S = Services> {
  constructor(
    protected readonly repos: R,
    protected readonly producer: RabbitProducer,
    protected readonly services: S,
    protected readonly bot: Bot | null,
  ) {}
}
