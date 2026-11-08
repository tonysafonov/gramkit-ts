/** Helpers of the admin module's integration tests: a service aggregator on a test database, outside any request. */
import { Repos } from '../../repos';
import { Services } from '../../services';
import type { TestApp } from '../../testing';

/** The real `Services` on the test database's pool (each call commits, as there is no request transaction). */
export function makeServices(t: TestApp): Services {
  return new Services(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);
}
