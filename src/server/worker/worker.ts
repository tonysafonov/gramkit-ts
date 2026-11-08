/**
 * The BullMQ worker: Python's `create_worker_settings` (arq). Same queue as `QueueClient` enqueues to.
 *
 * Python's behaviour, kept:
 * - `max_jobs=10`: ten jobs at once in a process.
 * - `job_timeout=600` seconds, 12 h for `user_broadcast_job` (`JobDefinition.timeout`). On timeout the job's signal is
 *   aborted and the run fails.
 * - A job that throws fails and is NOT retried: arq retries only on `Retry` or a stopped worker. BullMQ's default
 *   is one attempt too, and `QueueClient` sets no `attempts`.
 * - A worker that is stopped mid-job re-queues the job (arq cancels it and re-runs it): the signal is aborted, the job
 *   goes back to the queue delayed by a second, and a later run resumes (`user_broadcast_job` skips who it reached).
 * - An aborted job gets time to finish its own cleanup before the run ends, as a cancelled task does, so a shutdown
 *   can't close the database under the rows it is saving. `abortGraceMs` bounds that for a job that ignores the signal.
 * - Cron jobs are BullMQ job schedulers (UTC), one run per tick across all workers, no catch-up of missed ticks.
 */
import { DelayedError, type Job, Queue, Worker } from 'bullmq';
import { queueConnection } from '../clients/queue';
import { getLogger } from '../lib/logging';
import { WorkerContext, type WorkerResources } from './context';
import { type CronJob, DEFAULT_JOB_TIMEOUT, type JobDefinition, MAX_JOBS } from './types';

const logger = getLogger('worker');

const SCHEDULER_PREFIX = 'cron:';
const REQUEUE_DELAY_MS = 1000;
const ABORT_GRACE_MS = 5000;

export interface WorkerOptions {
  queueName: string;
  jobs: Readonly<Record<string, JobDefinition>>;
  cronJobs?: readonly CronJob[];
  resources: WorkerResources;
  concurrency?: number;
  /** Seconds. */
  defaultTimeout?: number;
  /** How long an aborted job may keep running to clean up. */
  abortGraceMs?: number;
}

export class JobTimeoutError extends Error {
  constructor(name: string, seconds: number) {
    super(`Job ${name} timed out after ${seconds}s`);
    this.name = 'JobTimeoutError';
  }
}

export class JobWorker {
  private worker: Worker | null = null;
  private queue: Queue | null = null;
  private readonly running = new Set<AbortController>();
  private stopping = false;

  constructor(private readonly options: WorkerOptions) {}

  /** Run one job: the handler against its context, raced with the timeout and a shutdown. */
  private async process(job: Job, token?: string): Promise<unknown> {
    const definition = Object.hasOwn(this.options.jobs, job.name) ? this.options.jobs[job.name] : undefined;
    if (!definition) throw new Error(`Function ${job.name} not found`);

    const abort = new AbortController();
    this.running.add(abort);
    const seconds = definition.timeout ?? this.options.defaultTimeout ?? DEFAULT_JOB_TIMEOUT;
    const ctx = new WorkerContext(this.options.resources, job.id ?? null, abort.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new JobTimeoutError(job.name, seconds);
        abort.abort(err);
        reject(err);
      }, seconds * 1000);
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason));
    });
    interrupted.catch(() => {}); // settled by whoever races it first
    logger.info(`Job ${job.id} started: ${job.name}`);
    const run = definition.handler(ctx, (job.data ?? {}) as Record<string, unknown>);
    try {
      const result = await Promise.race([run, interrupted]);
      logger.info(`Job ${job.id} completed: ${job.name}`);
      return result ?? null;
    } catch (err) {
      if (abort.signal.aborted) await this.finished(run);
      if (this.stopping && abort.signal.aborted && !(err instanceof JobTimeoutError) && token) {
        logger.warn(`Job ${job.id} (${job.name}) interrupted by shutdown, re-queued`);
        await job.moveToDelayed(Date.now() + REQUEUE_DELAY_MS, token);
        throw new DelayedError();
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.running.delete(abort);
    }
  }

  /** Wait for an aborted handler to end, however it ends, up to the grace period. */
  private async finished(run: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise((resolve) => {
      timer = setTimeout(resolve, this.options.abortGraceMs ?? ABORT_GRACE_MS);
    });
    await Promise.race([run.catch(() => {}), grace]);
    clearTimeout(timer);
  }

  /** Register the cron schedule and start taking jobs. */
  async start(): Promise<void> {
    const { queueName, cronJobs = [], concurrency = MAX_JOBS } = this.options;
    const connection = queueConnection();

    this.queue = new Queue(queueName, { connection });
    this.queue.on('error', (err: Error) => logger.warn({ err }, `Queue error: ${err.message}`));
    const wanted = new Set(cronJobs.map((cron) => SCHEDULER_PREFIX + cron.job));
    for (const scheduler of await this.queue.getJobSchedulers()) {
      // A job dropped from the schedule must stop firing.
      if (scheduler.key.startsWith(SCHEDULER_PREFIX) && !wanted.has(scheduler.key)) {
        await this.queue.removeJobScheduler(scheduler.key);
      }
    }
    for (const cron of cronJobs) {
      await this.queue.upsertJobScheduler(
        SCHEDULER_PREFIX + cron.job,
        { pattern: cron.pattern, tz: 'UTC' },
        {
          name: cron.job,
          data: {},
          opts: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } },
        },
      );
    }

    this.worker = new Worker(queueName, (job, token) => this.process(job, token), {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency,
      autorun: false,
    });
    this.worker.on('failed', (job, err) =>
      logger.error({ err }, `Job ${job?.id} failed: ${job?.name} - ${err.message}`),
    );
    this.worker.on('error', (err) => logger.error({ err }, `Worker error: ${err.message}`));
    void this.worker.run().catch((err) => logger.error({ err }, `Worker stopped: ${err}`));
    await this.worker.waitUntilReady();
    logger.info(
      `Worker started: queue ${queueName}, ${Object.keys(this.options.jobs).length} jobs, ${cronJobs.length} cron jobs`,
    );
  }

  /** Stop: abort what runs (it is re-queued), then close. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const abort of this.running) abort.abort(new Error('worker shutdown'));
    await this.worker?.close();
    await this.queue?.close();
    this.worker = null;
    this.queue = null;
  }
}
