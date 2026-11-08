/** The `adminTask` registry: no database, no app. Port of `tests/unit/test_admin_task_registry.py`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AdminTask, adminTask, adminTaskRegistry, getAdminTask, listAdminTasks } from './registry';

let saved: Map<string, AdminTask>;

// Each test starts from an empty registry; the real one is restored afterwards.
beforeEach(() => {
  saved = new Map(adminTaskRegistry);
  adminTaskRegistry.clear();
});
afterEach(() => {
  adminTaskRegistry.clear();
  for (const [name, task] of saved) adminTaskRegistry.set(name, task);
});

const noop = async () => ({ applied: false });

describe('adminTask', () => {
  it('registers and returns the function unchanged', () => {
    const decorated = adminTask('alpha', 'First task.', { destructive: true }, noop);

    expect(decorated).toBe(noop);
    const task = getAdminTask('alpha');
    expect(task).not.toBeNull();
    expect(task?.name).toBe('alpha');
    expect(task?.description).toBe('First task.');
    expect(task?.destructive).toBe(true);
    expect(task?.run).toBe(noop);
  });

  it('is not destructive by default', () => {
    adminTask('read_only', 'Reads only.', {}, noop);
    expect(getAdminTask('read_only')?.destructive).toBe(false);
  });

  it('lists sorted by name', () => {
    adminTask('zeta', 'Z.', {}, noop);
    adminTask('alpha', 'A.', {}, noop);
    adminTask('mu', 'M.', {}, noop);

    expect(listAdminTasks().map((task) => task.name)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('returns null for an unknown name', () => {
    expect(getAdminTask('does_not_exist')).toBeNull();
  });

  it('throws on a duplicate name and keeps the first registration', () => {
    adminTask('twice', 'First.', {}, noop);

    expect(() => adminTask('twice', 'Second.', {}, noop)).toThrow("'twice' is already registered");
    expect(getAdminTask('twice')?.description).toBe('First.');
  });
});
