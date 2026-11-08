import { Hono } from 'hono';
import { adminUser, ownerUser } from '../../auth/rbac';
import type { Env } from '../../env';
import { AdminTaskNotFoundException, NotFoundError } from '../../lib/errors';
import { validate } from '../../lib/validate';
import './app-tasks'; // registers the app's tasks, as the Python webhook app does at startup
import { RunAdminTaskRequest, TaskNameParam } from './schemas';

// Task errors other than "unknown task" are NOT caught here: they reach the global handler (500) and the request
// transaction rolls the task's writes back.
export const adminTasksRoutes = new Hono<Env>()
  /** Maintenance tasks runnable from the admin panel (run in this live process). */
  .get('/tasks', adminUser, (c) => c.json(c.var.services.adminTasks.listTasks()))
  /**
   * Run a maintenance task (owner-only). Defaults to a dry run; audit-logged. Runs inside the server process reusing
   * the request's transaction: the task's writes and the audit row commit together.
   */
  .post(
    '/tasks/:name',
    ownerUser,
    validate('param', TaskNameParam),
    validate('json', RunAdminTaskRequest),
    async (c) => {
      try {
        return c.json(
          await c.var.services.adminTasks.run(c.get('user'), c.req.valid('param').name, {
            dryRun: c.req.valid('json').dry_run,
          }),
        );
      } catch (e) {
        if (e instanceof AdminTaskNotFoundException) throw new NotFoundError(e.message);
        throw e;
      }
    },
  );
