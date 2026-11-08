/** The schedule and the job table keep Python's `worker.py` numbers. */
import { describe, expect, it } from 'vitest';
import { USER_BROADCAST_JOB_TIMEOUT } from '../modules/broadcasts/jobs';
import { cronJobs, DEFAULT_JOB_TIMEOUT, jobs, MAX_JOBS } from './registry';

describe('registry', () => {
  it('registers the jobs of Python WorkerSettings.functions', () => {
    expect(Object.keys(jobs).sort()).toEqual(
      [
        'admin_broadcast_job',
        'backup_database_job',
        'charge_expiring_subscriptions_job',
        'daily_admin_statistics_job',
        'evening_notification_job',
        'expire_outdated_subscriptions_job',
        'marketing_links_alerts_job',
        'morning_notification_job',
        'scheduled_backup_job',
        'send_delayed_notification',
        'test_error_job',
        'user_broadcast_job',
      ].sort(),
    );
  });

  it('keeps arq max_jobs and job_timeout, with the long timeout only for the broadcast', () => {
    expect(MAX_JOBS).toBe(10);
    expect(DEFAULT_JOB_TIMEOUT).toBe(600);
    expect(jobs.user_broadcast_job?.timeout).toBe(USER_BROADCAST_JOB_TIMEOUT);
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.timeout !== undefined)
        .map(([name]) => name),
    ).toEqual(['user_broadcast_job']);
  });

  it('has the cron schedule of worker.py (UTC)', () => {
    expect(Object.fromEntries(cronJobs.map((cron) => [cron.job, cron.pattern]))).toEqual({
      morning_notification_job: '0 * * * *',
      evening_notification_job: '0 * * * *',
      charge_expiring_subscriptions_job: '0 0,6,12,18 * * *',
      expire_outdated_subscriptions_job: '5 0 * * *',
      daily_admin_statistics_job: '55 1 * * *',
      scheduled_backup_job: '0 2 * * *',
      marketing_links_alerts_job: '20 * * * *',
    });
  });

  it('schedules only registered jobs', () => {
    expect(cronJobs.filter((cron) => !(cron.job in jobs))).toEqual([]);
  });
});
