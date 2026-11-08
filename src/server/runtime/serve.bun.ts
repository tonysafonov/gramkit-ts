/** Bun: one process per worker, sharing the port with `reusePort`. The parent only supervises. */
import type { Api } from '../app';
import { settings } from '../config';
import { getLogger } from '../lib/logging';
import { type RuntimeOptions, SOCKET_IO_PATH } from './socket';
import { onShutdownSignal, supervise } from './supervisor';

const logger = getLogger('serve');

const WORKER_FLAG = 'GRAMKIT_WORKER';

async function bindBunEngine(io: import('socket.io').Server) {
  const { Server: Engine } = await import('@socket.io/bun-engine');
  const engine = new Engine({ path: SOCKET_IO_PATH, pingTimeout: 20_000, pingInterval: 25_000, cors: { origin: '*' } });
  io.bind(engine as never);
  return engine;
}

async function runWorker<S, R>(loadApi: () => Promise<Api<S, R>>, options: RuntimeOptions): Promise<void> {
  const { host, port, keepAliveTimeout } = settings.server;
  const api = await loadApi();
  await api.startup();

  // Socket.IO on Bun runs on its own engine (the package is only loaded when an app asks for it)
  const socket = options.socketIo?.();
  const engine = socket ? await bindBunEngine(socket.io) : null;
  const appFetch = api.fetch as (request: Request) => Response | Promise<Response>;

  const server = Bun.serve({
    fetch: engine
      ? (request, server) =>
          new URL(request.url).pathname === SOCKET_IO_PATH
            ? engine.handleRequest(request, server as never)
            : appFetch(request)
      : appFetch,
    websocket: engine?.handler().websocket as never,
    hostname: host,
    port,
    reusePort: true,
    // Bun's one timeout for an idle connection: keep-alive above the proxy's idle timeout
    idleTimeout: keepAliveTimeout,
  });
  logger.info(`Worker ${process.pid} listening on ${host}:${port} (bun ${Bun.version})`);

  // A supervisor killed with SIGKILL can't stop its workers; the closed IPC channel tells them
  process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));

  onShutdownSignal(async () => {
    void server.stop();
    socket?.close();
    await api.shutdown();
    await server.stop(true);
  });
}

/** Run the API on Bun: `WORKERS` processes, restarted when they die. */
export function runBun<S, R>(loadApi: () => Promise<Api<S, R>>, options: RuntimeOptions = {}): void {
  if (process.env[WORKER_FLAG]) {
    void runWorker(loadApi, options);
    return;
  }
  supervise(() => {
    const worker = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      env: { ...process.env, [WORKER_FLAG]: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      ipc: () => {},
    });
    return {
      pid: worker.pid,
      exited: worker.exited,
      kill: (signal) => worker.kill(signal),
    };
  });
}
