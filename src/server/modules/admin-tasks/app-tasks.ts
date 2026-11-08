/**
 * This app's admin tasks (Python's `app/services/admin_tasks.py`): owner-run maintenance, executed inside the live
 * server process. The framework is `registry.ts` + `service.ts` + `routes.ts`: the `adminTask` registry, the
 * `GET /admin/tasks` / `POST /admin/tasks/:name` endpoints (list: admin, run: owner), and an audit row for every run.
 * The app imports this module once at startup (`import './modules/admin-tasks/app-tasks'`); that import is what
 * registers the tasks below.
 *
 * Use a task, not a script, for data fixes on a running server: it reuses the request's transaction, so there is no
 * second app to boot, and its writes commit together with the audit row. A throw rolls both back.
 *
 * Writing a task: `async (db, { dryRun }) => ({ ... })`. Return a JSON-serialisable object (it is stored in the audit
 * row): ISO strings for dates. A task that changes data is `destructive: true`, changes nothing when `dryRun` is true
 * and returns `{ applied: boolean, ... }`. Names are unique: registering one twice throws at startup.
 */
import { count, gte } from 'drizzle-orm';
import { users } from '../../db/schema';
import { adminTask } from './registry';

adminTask(
  'users_overview',
  'Read-only. Counts users by role and by type, and sign-ups in the last 7 days. Changes nothing.',
  {},
  async (db) => {
    const byRoleRows = await db.select({ role: users.role, total: count() }).from(users).groupBy(users.role);
    const byTypeRows = await db
      .select({ userType: users.userType, total: count() })
      .from(users)
      .groupBy(users.userType);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [recent] = await db.select({ total: count() }).from(users).where(gte(users.createdAt, weekAgo));

    const byRole = Object.fromEntries(byRoleRows.map((row) => [row.role, row.total]));
    const byType = Object.fromEntries(byTypeRows.map((row) => [row.userType, row.total]));
    return {
      applied: false,
      total_users: byRoleRows.reduce((sum, row) => sum + row.total, 0),
      by_role: byRole,
      by_type: byType,
      new_last_7_days: recent?.total ?? 0,
    };
  },
);
