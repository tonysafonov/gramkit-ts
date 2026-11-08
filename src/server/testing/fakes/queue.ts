import { type EnqueueOptions, QueueClient } from '../../clients/queue';

export interface EnqueuedJob {
  jobName: string;
  payload: object;
  options: EnqueueOptions;
}

/** Records jobs instead of enqueuing them. */
export class FakeQueue extends QueueClient {
  readonly jobs: EnqueuedJob[] = [];

  override async enqueueJob(
    jobName: string,
    payload: object = {},
    options: EnqueueOptions = {},
  ): Promise<{ jobId: string }> {
    this.jobs.push({ jobName, payload, options });
    return { jobId: options.jobId ?? `fake-job-${this.jobs.length}` };
  }

  override async close(): Promise<void> {}
}
