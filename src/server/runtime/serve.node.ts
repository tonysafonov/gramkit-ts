/** Node: node:cluster + @hono/node-server. The primary only supervises; each worker runs the app. */
import cluster from 'node:cluster';
import { serve } from '@hono/node-server';
import type { Api } from '../app';
import { settings } from '../config';
import { getLogger } from '../lib/logging';
import { type RuntimeOptions, SOCKET_IO_PATH } from './socket';
import { onShutdownSignal, supervise } from './supervisor';

const logger = getLogger('serve');

async function runWorker<S, R>(loadApi: () => Promise<Api<S, R>>, options: RuntimeOptions): Promise<void> {
  const { host, port, keepAliveTimeout } = settings.server;
  const api = await loadApi();
  await api.startup();

  const server = serve({ fetch: api.fetch, hostname: host, port }, () => {
    logger.info(`Worker ${process.pid} listening on ${host}:${port} (node ${process.version})`);
  });
  // Keep-alive above the proxy's idle timeout, or a reused connection can die under a request.
  const httpServer = server as import('node:http').Server;
  httpServer.keepAliveTimeout = keepAliveTimeout * 1000;
  httpServer.headersTimeout = (keepAliveTimeout + 1) * 1000;

  // Socket.IO takes the requests and upgrades under /socket.io, the rest goes on to the app
  const socket = options.socketIo?.();
  socket?.io.attach(httpServer, { path: SOCKET_IO_PATH, serveClient: false });

  onShutdownSignal(async () => {
    httpServer.close();
    socket?.close();
    await api.shutdown();
    httpServer.closeAllConnections();
  });
}

/** Run the API on Node: `WORKERS` processes, restarted when they die. */
export function runNode<S, R>(loadApi: () => Promise<Api<S, R>>, options: RuntimeOptions = {}): void {
  if (!cluster.isPrimary) {
    void runWorker(loadApi, options);
    return;
  }
  supervise(() => {
    const worker = cluster.fork();
    return {
      pid: worker.process.pid,
      exited: new Promise((resolve) => {
        worker.once('exit', (code, signal) => resolve(signal ?? code));
      }),
      kill: (signal) => worker.process.kill(signal),
    };
  });
}
