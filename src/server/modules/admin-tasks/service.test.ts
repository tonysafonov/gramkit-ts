/**
 * AdminTasksService on the app's aggregator. Tasks are registered on an empty registry per test. The audit-row shape is
 * locked here on purpose: app tasks read it back (a once-only guard queries
 * `action = 'admin_task:<name>' AND detail->'result'->>'applied' = 'true'`). Port of
 * `tests/integration/test_admin_tasks_service.py`.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs, UserRole } from '../../db/schema';
import { AdminTaskNotFoundException } from '../../lib/errors';
import type { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { makeServices } from '../admin/testing';
import { type AdminTask, adminTask, adminTaskRegistry } from './registry';

let t: TestApp;
let services: Services;
let saved: Map<string, AdminTask>;

beforeAll(async () => {
  t = await createTestApp();
  services = makeServices(t);
});
afterAll(() => t.close());

beforeEach(() => {
  saved = new Map(adminTaskRegistry);
  adminTaskRegistry.clear();
});
afterEach(() => {
  adminTaskRegistry.clear();
  for (const [name, task] of saved) adminTaskRegistry.set(name, task);
});

const owner = () => createUser(t.db, { role: UserRole.OWNER });
const auditRows = (action: string) => t.db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, action));
const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

describe('run', () => {
  it('passes the request handle and dry_run', async () => {
    const name = unique('seen');
    const seen: [unknown, boolean][] = [];
    adminTask(name, 'Records its arguments.', {}, async (db, { dryRun }) => {
      seen.push([db, dryRun]);
      return { applied: false };
    });

    const actor = await owner();
    await services.adminTasks.run(actor, name, { dryRun: true });
    await services.adminTasks.run(actor, name, { dryRun: false });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBe(services.repos.db);
    expect(seen.map(([, dryRun]) => dryRun)).toEqual([true, false]);
  });

  it('returns the result and writes the exact audit shape', async () => {
    const name = unique('shape');
    adminTask(name, 'Applies when not a dry run.', { destructive: true }, async (_db, { dryRun }) => ({
      applied: !dryRun,
      count: 3,
    }));

    const actor = await owner();
    const outcome = await services.adminTasks.run(actor, name, { dryRun: false });

    expect(outcome.task).toBe(name);
    expect(outcome.dry_run).toBe(false);
    expect(outcome.result).toEqual({ applied: true, count: 3 });

    const rows = await auditRows(`admin_task:${name}`);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorUserId).toBe(actor.id);
    expect(row?.actorRole).toBe('owner');
    expect(row?.targetType).toBe('admin_task');
    expect(row?.targetId).toBe(name);
    expect(row?.detail).toEqual({ dry_run: false, result: { applied: true, count: 3 } });
  });

  it('keeps the applied flag queryable as jsonb', async () => {
    const name = unique('guard');
    adminTask(name, 'Guarded.', { destructive: true }, async (_db, { dryRun }) => ({ applied: !dryRun }));

    const actor = await owner();
    const countApplied = async () => {
      const rows = await t.db.execute<{ count: string }>(
        sql`SELECT count(*) FROM admin_audit_logs WHERE action = ${`admin_task:${name}`} AND detail->'result'->>'applied' = 'true'`,
      );
      return Number(rows[0]?.count);
    };

    await services.adminTasks.run(actor, name, { dryRun: true });
    const dry = await countApplied();
    await services.adminTasks.run(actor, name, { dryRun: false });
    const applied = await countApplied();

    expect(dry).toBe(0);
    expect(applied).toBe(1);
  });

  it('throws not found for an unknown task', async () => {
    const actor = await owner();

    const failure = services.adminTasks.run(actor, 'x', { dryRun: true });
    await expect(failure).rejects.toBeInstanceOf(AdminTaskNotFoundException);
    await expect(failure).rejects.toThrow(/^Unknown task: x$/);
  });

  it('propagates a failing task and writes no audit row', async () => {
    const name = unique('boom');
    adminTask(name, 'Always fails.', { destructive: true }, async () => {
      throw new Error('task failed');
    });
    const actor = await owner();

    await expect(services.adminTasks.run(actor, name, { dryRun: false })).rejects.toThrow('task failed');

    expect(await auditRows(`admin_task:${name}`)).toEqual([]);
  });
});

describe('listTasks', () => {
  it('returns task info sorted by name', () => {
    const noop = async () => ({ applied: false });
    adminTask('b_task', 'B.', { destructive: true }, noop);
    adminTask('a_task', 'A.', {}, noop);

    expect(services.adminTasks.listTasks()).toEqual([
      { name: 'a_task', description: 'A.', destructive: false },
      { name: 'b_task', description: 'B.', destructive: true },
    ]);
  });
});
