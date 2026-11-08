/** Keeps `count` workers running, whichever way a runtime spawns them. A dead worker is replaced; SIGTERM ends all. */
import { settings } from '../config';
import { flushLogs, getLogger } from '../lib/logging';

const logger = getLogger('supervisor');

/** A worker that dies sooner than this after starting is respawned with a pause: it may be failing on boot. */
const MIN_UPTIME_MS = 1000;
const RESPAWN_DELAY_MS = 1000;
/** After the drain timeout, how long workers get to close their clients before SIGKILL. */
const KILL_GRACE_SECONDS = 5;

export interface WorkerHandle {
  pid: number | undefined;
  exited: Promise<unknown>;
  kill(signal: NodeJS.Signals): void;
}

export function supervise(spawn: () => WorkerHandle, count: number = settings.server.workers): void {
  const workers = new Set<WorkerHandle>();
  let stopping = false;

  const start = () => {
    const worker = spawn();
    const startedAt = performance.now();
    workers.add(worker);
    logger.info(`Worker ${worker.pid} started`);

    void worker.exited.then((status) => {
      workers.delete(worker);
      if (stopping) {
        if (workers.size === 0) {
          flushLogs();
          process.exit(0);
        }
        return;
      }
      logger.warn(`Worker ${worker.pid} exited (${status}), starting a new one`);
      const lived = performance.now() - startedAt;
      setTimeout(start, lived < MIN_UPTIME_MS ? RESPAWN_DELAY_MS : 0);
    });
  };

  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: stopping ${workers.size} workers`);
    for (const worker of workers) worker.kill(signal);
    const graceMs = (settings.web.shutdownDrainTimeout + KILL_GRACE_SECONDS) * 1000;
    setTimeout(() => {
      for (const worker of workers) worker.kill('SIGKILL');
    }, graceMs).unref();
    if (workers.size === 0) process.exit(0);
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  for (let i = 0; i < count; i++) start();
}

/** A worker's shutdown: runs `stop` once on SIGTERM or SIGINT, then exits. */
export function onShutdownSignal(stop: () => Promise<void>): void {
  let stopping = false;
  const handle = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: worker ${process.pid} shutting down`);
    try {
      await stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      flushLogs();
      process.exit(1);
    }
  };
  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
  // As in Python, a failed background task is logged and the worker keeps serving.
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled rejection'));
}
