import type { Bot } from 'grammy';
import type { QueueClient } from '../../../../src/server/clients/queue';
import type { RabbitProducer } from '../../../../src/server/clients/rabbit';
import type { RedisClient } from '../../../../src/server/clients/redis';
import type { ConduitRepos } from '../repos';
import { ArticlesService } from './articles';
import { CommentsService } from './comments';
import { ConduitUsersService } from './users';

/** Service aggregator, composed like the framework's `Services`: `getServices` builds one per request. */
export class ConduitServices {
  #conduitUsers?: ConduitUsersService;
  #articles?: ArticlesService;
  #comments?: CommentsService;

  constructor(
    readonly repos: ConduitRepos,
    readonly producer: RabbitProducer,
    readonly bot: Bot | null,
    readonly redis: RedisClient,
    readonly queue: QueueClient,
  ) {}

  get conduitUsers() {
    return (this.#conduitUsers ??= new ConduitUsersService(this.repos, this.producer, this, this.bot));
  }

  get articles() {
    return (this.#articles ??= new ArticlesService(this.repos, this.producer, this, this.bot));
  }

  get comments() {
    return (this.#comments ??= new CommentsService(this.repos, this.producer, this, this.bot));
  }
}
