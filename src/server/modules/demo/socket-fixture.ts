/** Entry for `socket.runtime.test.ts`: the real runtime servers with the real demo socket hook and a stub API. */
import { runBun } from '../../runtime/serve.bun';
import { runNode } from '../../runtime/serve.node';
import { createDemoSocketServer } from './socket';

const loadApi = async () =>
  ({
    fetch: () => new Response('stub api'),
    startup: async () => {},
    shutdown: async () => {},
  }) as never;

const options = { socketIo: () => createDemoSocketServer({ simulationDelayMs: () => 200 }) };

if (process.env.FIXTURE_RUNTIME === 'bun') runBun(loadApi, options);
else runNode(loadApi, options);
