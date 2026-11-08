import { type JobsOptions, Queue } from 'bullmq';
import { settings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('queue');

/** BullMQ's queue names may not contain `:`. The worker consumes the same one. */
export const QUEUE_NAME = `${settings.appName}-jobs`;

/** Redis connection options for BullMQ (a `Worker` needs `maxRetriesPerRequest: null`). */
export const queueConnection = () => ({
  host: settings.redis.host,
  port: settings.redis.port,
  password: settings.redis.password || undefined,
});

export interface EnqueueOptions {
  /** Run after this many seconds (arq's `_defer_by`). */
  deferBy?: number;
  /** Run at this time (arq's `_defer_until`). */
  deferUntil?: Date;
  /** A job with this id is enqueued once while it exists (arq's `_job_id`). */
  jobId?: string;
}

/** Enqueues background jobs. One per process; the Redis connection opens with the first job. */
export class QueueClient {
  private queue: Queue | null = null;

  private getQueue(): Queue {
    if (!this.queue) {
      this.queue = new Queue(QUEUE_NAME, {
        connection: queueConnection(),
        defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } },
      });
      this.queue.on('error', (err: Error) => logger.warn({ err }, `Queue error: ${err.message}`));
    }
    return this.queue;
  }

  /** Open the connection now instead of with the first job. */
  async connect(): Promise<void> {
    await this.getQueue().waitUntilReady();
  }

  async enqueueJob(jobName: string, payload: object = {}, options: EnqueueOptions = {}): Promise<{ jobId: string }> {
    const opts: JobsOptions = {};
    if (options.deferBy !== undefined) opts.delay = options.deferBy * 1000;
    if (options.deferUntil) opts.delay = Math.max(options.deferUntil.getTime() - Date.now(), 0);
    if (options.jobId) opts.jobId = options.jobId;
    const job = await this.getQueue().add(jobName, payload, opts);
    return { jobId: job.id ?? '' };
  }

  async close(): Promise<void> {
    const queue = this.queue;
    this.queue = null;
    await queue?.close();
  }
}
