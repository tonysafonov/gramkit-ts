/**
 * Conduit on gramkit-ts: the same `createApi` (middleware, lifespan, error handler hook) as the template. The process
 * clients are the framework's: `getClients` builds one Bot, queue, Redis and Rabbit client per process.
 */
import { createApi } from '../../../src/server/app';
import { getClients } from '../../../src/server/clients';
import { conduitErrorHandler, conduitRoutingError } from './errors';
import { ConduitRepos } from './repos';
import { conduitRoutes } from './routes';
import { ConduitServices } from './services';

export function createConduitApi() {
  return createApi({
    reposClass: ConduitRepos,
    servicesClass: ConduitServices,
    routes: conduitRoutes,
    title: 'Conduit on gramkit-ts',
    version: 'bench',
    errorHandler: conduitErrorHandler,
    routingError: conduitRoutingError,
    onStartup: [
      // Python's lifespan opens the arq pool at startup; `QueueClient` waits for its first job. Open it here, so a
      // process pays for its queue connection when Python's does.
      () => getClients().queue.connect(),
    ],
  });
}
