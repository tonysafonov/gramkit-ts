import { BaseService } from '../../lib/base-service';
import { AdminTaskNotFoundException } from '../../lib/errors';
import type { UserSchema } from '../users/schemas';
import { getAdminTask, listAdminTasks } from './registry';
import type { AdminTaskInfo, AdminTaskRunResult } from './schemas';

/**
 * Lists registered tasks and runs one inside the request transaction, with an audit row.
 *
 * Every run is audit-logged as `action = "admin_task:<name>"`, `targetType = "admin_task"`, `targetId = <name>`,
 * `detail = { dry_run, result }`. Tasks may read that shape back (a once-only guard querying
 * `detail->'result'->>'applied'`), so keep it. Gating lives in the routes (list: admin, run: owner).
 */
export class AdminTasksService extends BaseService {
  /** Registered tasks for the admin Tasks list, sorted by name. */
  listTasks(): AdminTaskInfo[] {
    return listAdminTasks().map(({ name, description, destructive }) => ({ name, description, destructive }));
  }

  /**
   * Run task `name` on the request's database handle, then record the audit row. The task runs first: a task that
   * throws writes no audit row, and the error propagates so the request transaction rolls its partial writes back.
   */
  async run(actor: UserSchema, name: string, { dryRun }: { dryRun: boolean }): Promise<AdminTaskRunResult> {
    const task = getAdminTask(name);
    if (task === null) throw new AdminTaskNotFoundException(`Unknown task: ${name}`);

    const result = await task.run(this.repos.db, { dryRun });

    await this.services.auditLog.record(actor, `admin_task:${name}`, 'admin_task', name, {
      dry_run: dryRun,
      result,
    });
    return { task: name, dry_run: dryRun, result };
  }
}
