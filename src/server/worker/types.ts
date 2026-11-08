/** What the registry and the worker share. */
import type { JobHandler } from './jobs';

/** Seconds a job may run unless it says otherwise (arq's `job_timeout`). */
export const DEFAULT_JOB_TIMEOUT = 600;
/** Jobs running at once in one worker process (arq's `max_jobs`). */
export const MAX_JOBS = 10;

export interface JobDefinition {
  handler: JobHandler;
  /** Seconds; `DEFAULT_JOB_TIMEOUT` when absent. */
  timeout?: number;
  /** The payload keys the job reads (Python's parameter names), for the enqueue check. */
  params: readonly string[];
}

export interface CronJob {
  /** The job name in `jobs`. */
  job: string;
  /** Cron pattern, UTC. */
  pattern: string;
  /** What arq's `cron(...)` was given, for the reader. */
  description: string;
}
