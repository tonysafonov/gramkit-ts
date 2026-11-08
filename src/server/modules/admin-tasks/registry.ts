/**
 * The `adminTask` registry: owner-run maintenance that runs inside the live server process.
 *
 * Register `async (db, { dryRun }) => result` with `adminTask(name, description, { destructive }, fn)`. The registry
 * is module-level; the app imports its task module once at startup: there is no discovery.
 *
 * A run reuses the request's database handle (its transaction): the task's writes and its audit row commit together,
 * and a throw rolls both back. The returned object is stored in the audit row (JSONB), so it must be
 * JSON-serialisable (dates as ISO strings).
 *
 * Convention: a task that changes data is `destructive: true`, changes nothing when `dryRun` is true, and returns
 * `{ applied: boolean, ... }`.
 */
import type { Db } from '../../db/client';

export type TaskFn = (db: Db, options: { dryRun: boolean }) => Promise<Record<string, unknown>>;

export interface AdminTask {
  name: string;
  description: string;
  destructive: boolean;
  run: TaskFn;
}

/** The registry itself, exported so tests can swap entries in and out (Python's `_REGISTRY`). */
export const adminTaskRegistry = new Map<string, AdminTask>();

/**
 * Register an admin task. Returns `fn` unchanged. Throws if a task with the same name is already registered, so a
 * name clash fails at startup instead of silently replacing a task.
 */
export function adminTask(name: string, description: string, options: { destructive?: boolean }, fn: TaskFn): TaskFn {
  if (adminTaskRegistry.has(name)) throw new Error(`Admin task '${name}' is already registered`);
  adminTaskRegistry.set(name, { name, description, destructive: options.destructive ?? false, run: fn });
  return fn;
}

/** All registered tasks, sorted by name. */
export const listAdminTasks = (): AdminTask[] =>
  [...adminTaskRegistry.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** The task registered under `name`, or `null`. */
export const getAdminTask = (name: string): AdminTask | null => adminTaskRegistry.get(name) ?? null;
