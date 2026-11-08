/** The BullMQ worker against the local Redis (`make up`): timeouts, failures without retry, requeue on shutdown, cron. */
import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queueConnection } from '../clients/queue';
import { createTestApp, type TestApp } from '../testing';
import type { TestServices } from '../testing/auth';
import type { JobHandler } from './jobs';
import type { JobDefinition } from './types';
import { JobWorker } from './worker';

let app: TestApp<TestServices>;
let queue: Queue;
let worker: JobWorker | null = null;
const queueName = () => `gramkit-ts-worker-test-${randomBytes(4).toString('hex')}`;

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function start(
  jobs: Record<string, JobDefinition>,
  options: { defaultTimeout?: number; cron?: boolean; abortGraceMs?: number } = {},
) {
  const name = queueName();
  queue = new Queue(name, { connection: queueConnection() });
  const { bot, redis, queue: fakeQueue, producer } = app.fakes;
  worker = new JobWorker({
    queueName: name,
    jobs,
    cronJobs: options.cron ? [{ job: 'tick', pattern: '* * * * *', description: 'every minute' }] : [],
    resources: { db: app.db, bot: bot.bot, redis, queue: fakeQueue, producer },
    defaultTimeout: options.defaultTimeout,
    abortGraceMs: options.abortGraceMs,
  });
  await worker.start();
  return queue;
}

const job = (handler: JobHandler, extra: Partial<JobDefinition> = {}): JobDefinition => ({
  handler,
  params: [],
  ...extra,
});

beforeEach(async () => {
  app = await createTestApp();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
  await queue?.obliterate({ force: true });
  await queue?.close();
  await app.close();
});

describe('JobWorker', () => {
  it('runs a job with its payload and stores the result', async () => {
    let seen: unknown;
    const q = await start({ echo: job(async (_ctx, data) => (seen = data)) });
    const added = await q.add('echo', { telegram_user_id: 7 });
    await until(async () => (await added.getState()) === 'completed');
    expect(seen).toEqual({ telegram_user_id: 7 });
  });

  it('fails a throwing job once, with no retry', async () => {
    let runs = 0;
    const q = await start({
      boom: job(async () => {
        runs += 1;
        throw new Error('Test error');
      }),
    });
    const added = await q.add('boom', {});
    await until(async () => (await added.getState()) === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs).toBe(1);
    expect((await q.getJob(added.id as string))?.failedReason).toBe('Test error');
  });

  it('fails an unknown job name', async () => {
    const q = await start({});
    const added = await q.add('nope', {});
    await until(async () => (await added.getState()) === 'failed');
    expect((await q.getJob(added.id as string))?.failedReason).toBe('Function nope not found');
  });

  it('times a job out and aborts its signal', async () => {
    let aborted = false;
    const q = await start(
      {
        slow: job(
          (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
                resolve(null);
              });
            }),
          { timeout: 0.2 },
        ),
      },
      { defaultTimeout: 600 },
    );
    const added = await q.add('slow', {});
    await until(async () => (await added.getState()) === 'failed');
    expect(aborted).toBe(true);
    expect((await q.getJob(added.id as string))?.failedReason).toContain('timed out after 0.2s');
  });

  it('gives the handler its job id', async () => {
    let id: string | null = null;
    const q = await start({ who: job(async (ctx) => (id = ctx.jobId)) });
    const added = await q.add('who', {}, { jobId: 'my-job-id' });
    await until(async () => (await added.getState()) === 'completed');
    expect(id).toBe('my-job-id');
  });

  it('re-queues a running job when the worker is stopped, and a later run finishes it', async () => {
    let started = false;
    const q = await start({
      long: job(
        (ctx) =>
          new Promise((_, reject) => {
            started = true;
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          }),
      ),
    });
    const added = await q.add('long', {});
    await until(() => started);
    await worker?.stop();
    worker = null;
    expect(await added.getState()).toBe('delayed');

    let finished = 0;
    const name = q.name;
    const { bot, redis, queue: fakeQueue, producer } = app.fakes;
    worker = new JobWorker({
      queueName: name,
      jobs: { long: job(async () => void (finished += 1)) },
      resources: { db: app.db, bot: bot.bot, redis, queue: fakeQueue, producer },
    });
    await worker.start();
    await until(async () => (await added.getState()) === 'completed');
    expect(finished).toBe(1);
  });

  it('a stop waits for an aborted job to save its work', async () => {
    let started = false;
    let saved = false;
    const q = await start({
      long: job(
        (ctx) =>
          new Promise((_, reject) => {
            started = true;
            ctx.signal.addEventListener('abort', () => {
              setTimeout(() => {
                saved = true;
                reject(ctx.signal.reason);
              }, 150);
            });
          }),
      ),
    });
    const added = await q.add('long', {});
    await until(() => started);

    await worker?.stop();
    worker = null;

    expect(saved).toBe(true);
    expect(await added.getState()).toBe('delayed');
  });

  it('a stop gives up on a job that ignores the signal after the grace period', async () => {
    let started = false;
    const q = await start(
      {
        stuck: job(() => {
          started = true;
          return new Promise(() => {});
        }),
      },
      { abortGraceMs: 50 },
    );
    const added = await q.add('stuck', {});
    await until(() => started);

    await worker?.stop();
    worker = null;

    expect(await added.getState()).toBe('delayed');
  });

  it('registers cron jobs as schedulers, and drops one that left the schedule', async () => {
    const q = await start({ tick: job(async () => null) }, { cron: true });
    const keys = async () => (await q.getJobSchedulers()).map((s) => s.key);
    expect(await keys()).toEqual(['cron:tick']);
    expect((await q.getJobSchedulers())[0]?.pattern).toBe('* * * * *');
    expect((await q.getJobSchedulers())[0]?.tz).toBe('UTC');

    await worker?.stop();
    const { bot, redis, queue: fakeQueue, producer } = app.fakes;
    worker = new JobWorker({
      queueName: q.name,
      jobs: {},
      cronJobs: [],
      resources: { db: app.db, bot: bot.bot, redis, queue: fakeQueue, producer },
    });
    await worker.start();
    expect(await keys()).toEqual([]);
  });
});
