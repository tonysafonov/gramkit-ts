import { z } from 'zod';

/** A runnable admin task, for the Tasks list. */
export interface AdminTaskInfo {
  name: string;
  description: string;
  destructive: boolean;
}

/** Run options. Defaults to a dry run so nothing mutates by accident. */
export const RunAdminTaskRequest = z.object({ dry_run: z.boolean().default(true) });

export const TaskNameParam = z.object({ name: z.string() });

/** Outcome of running a task. */
export interface AdminTaskRunResult {
  task: string;
  dry_run: boolean;
  result: Record<string, unknown>;
}
