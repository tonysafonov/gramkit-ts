/**
 * The worker process: Python's `app/worker/worker.py` (arq). Runs the BullMQ worker with the cron schedule.
 *
 *     bun src/server/worker/main.ts     # dev
 *     node dist/worker.node.js          # prod
 */
import pkg from '../../../package.json';
import { closeClients, getClients, getSharedBot, posthog } from '../clients';
import { initSentry } from '../clients/sentry';
import { settings } from '../config';
import { createDb } from '../db/client';
import { flushLogs, getLogger } from '../lib/logging';
import { announceStart } from '../modules/messages/admin-messages';
import { setupRegistries } from '../registries';
import { onShutdownSignal } from '../runtime/supervisor';
import { cronJobs, jobs, MAX_JOBS, QUEUE_NAME } from './registry';
import { JobWorker } from './worker';

const logger = getLogger('worker-main');

export async function main(): Promise<void> {
  logger.info('Worker starting');
  initSentry(pkg.version);
  posthog.setup(settings.observability.posthogApiKey, settings.observability.posthogHost, pkg.version);
  setupRegistries();

  const db = createDb();
  const clients = getClients();
  const bot = getSharedBot();
  const worker = new JobWorker({
    queueName: QUEUE_NAME,
    jobs,
    cronJobs,
    concurrency: MAX_JOBS,
    resources: { db: db.db, bot, redis: clients.redis, queue: clients.queue, producer: clients.producer },
  });

  onShutdownSignal(async () => {
    logger.info('Worker shutdown');
    await worker.stop();
    await closeClients();
    await db.close();
    flushLogs();
  });

  await worker.start();
  await announceStart('worker', pkg.version, bot);
}

main().catch((err) => {
  logger.error({ err }, `Worker failed to start: ${err}`);
  flushLogs();
  process.exit(1);
});
