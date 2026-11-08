/**
 * Every job the worker runs, by the name `enqueueJob` uses (Python's `WorkerSettings.functions`), with its timeout.
 * Port of the template app's `worker/worker.py`; the jobs themselves live with their modules.
 */
import { QUEUE_NAME } from '../clients/queue';
import { USER_BROADCAST_JOB_TIMEOUT } from '../modules/broadcasts/jobs';
import { marketingLinksAlertsJob } from '../modules/marketing-links/jobs';
import { eveningNotificationJob, morningNotificationJob } from '../modules/notifications/jobs';
import { jobs as subscriptionJobs } from '../modules/subscriptions/jobs';
import {
  adminBroadcastJob,
  backupDatabaseJob,
  dailyAdminStatisticsJob,
  scheduledBackupJob,
  sendDelayedNotification,
  testErrorJob,
  userBroadcastJobHandler,
} from './jobs';

export { type CronJob, DEFAULT_JOB_TIMEOUT, type JobDefinition, MAX_JOBS } from './types';
export { QUEUE_NAME };

import type { CronJob, JobDefinition } from './types';

export const jobs: Readonly<Record<string, JobDefinition>> = {
  admin_broadcast_job: { handler: adminBroadcastJob, params: ['text', 'rich_html', 'silent'] },
  backup_database_job: { handler: backupDatabaseJob, params: ['requester_telegram_id'] },
  scheduled_backup_job: { handler: scheduledBackupJob, params: [] },
  // A whole-audience blast outlives the worker-wide job timeout.
  user_broadcast_job: {
    handler: userBroadcastJobHandler,
    timeout: USER_BROADCAST_JOB_TIMEOUT,
    params: ['broadcast_data', 'requester_telegram_id', 'broadcast_id'],
  },
  morning_notification_job: { handler: (ctx) => morningNotificationJob(ctx), params: [] },
  evening_notification_job: { handler: (ctx) => eveningNotificationJob(ctx), params: [] },
  daily_admin_statistics_job: { handler: dailyAdminStatisticsJob, params: [] },
  charge_expiring_subscriptions_job: {
    handler: (ctx) => subscriptionJobs.charge_expiring_subscriptions_job(ctx),
    params: [],
  },
  expire_outdated_subscriptions_job: {
    handler: (ctx) => subscriptionJobs.expire_outdated_subscriptions_job(ctx),
    params: [],
  },
  marketing_links_alerts_job: { handler: (ctx) => marketingLinksAlertsJob(ctx), params: [] },
  send_delayed_notification: {
    handler: sendDelayedNotification,
    params: ['telegram_user_id', 'delay_seconds'],
  },
  test_error_job: { handler: testErrorJob, params: [] },
};

/** Python's cron schedule, all UTC. The notification jobs run hourly: each user's local morning/evening hour. */
export const cronJobs: readonly CronJob[] = [
  { job: 'morning_notification_job', pattern: '0 * * * *', description: 'every hour at :00' },
  { job: 'evening_notification_job', pattern: '0 * * * *', description: 'every hour at :00' },
  { job: 'charge_expiring_subscriptions_job', pattern: '0 0,6,12,18 * * *', description: '00:00 06:00 12:00 18:00' },
  { job: 'expire_outdated_subscriptions_job', pattern: '5 0 * * *', description: 'daily at 00:05' },
  {
    job: 'daily_admin_statistics_job',
    pattern: '55 1 * * *',
    description: 'daily at 01:55 (end of the 02:00-UTC day)',
  },
  { job: 'scheduled_backup_job', pattern: '0 2 * * *', description: 'daily at 02:00' },
  // Owner alerts; silent without RBAC__OWNER_IDS
  { job: 'marketing_links_alerts_job', pattern: '20 * * * *', description: 'every hour at :20' },
];
