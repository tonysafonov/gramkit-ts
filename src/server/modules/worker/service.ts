import type { Bot } from 'grammy';
import type { EnqueueOptions, QueueClient } from '../../clients';
import type { RabbitProducer } from '../../clients/rabbit';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import type { Repos } from '../../repos';
import type { Services } from '../../services';

const logger = getLogger('worker-service');

export class WorkerService extends BaseService {
  constructor(
    protected readonly queue: QueueClient,
    repos: Repos,
    producer: RabbitProducer,
    services: Services,
    bot: Bot | null,
  ) {
    super(repos, producer, services, bot);
  }

  /** Enqueue a job to be processed by the worker. */
  async enqueueJob(jobName: string, payload?: object, options?: EnqueueOptions): Promise<{ jobId: string }> {
    const job = await this.queue.enqueueJob(jobName, payload, options);
    logger.info(`Enqueued job ${jobName} with ID ${job.jobId}`);
    return job;
  }
}
