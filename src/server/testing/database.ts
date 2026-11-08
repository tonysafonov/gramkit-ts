/**
 * Test databases. One migrated template per test run (`global-setup.ts`), then a clone per test file, so files run in
 * parallel without seeing each other. `CREATE DATABASE ... TEMPLATE` copies the schema in milliseconds.
 *
 * Every name carries the run's id, the pid of the vitest process, so runs side by side never touch each other's
 * databases: a run drops its own at the end, and at the start only what a dead run left behind.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { type DbConfig, settings } from '../config';

/** Global setup runs in the vitest process and hands its pid to the test workers. */
const RUN_ID = (process.env.GRAMKIT_TEST_RUN ??= String(process.pid));

export const TEMPLATE_DATABASE = `${settings.db.name}_template_${RUN_ID}`;
const CLONE_PREFIX = `${settings.db.name}_file_${RUN_ID}_`;
/** Any run's test database, with the pid that made it. */
const TEST_DATABASE = new RegExp(`^${settings.db.name}_(?:template|file)_(\\d+)(?:_|$)`);

/** A short-lived connection to the maintenance database, for CREATE and DROP DATABASE. */
export async function withAdminConnection<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const { host, port, user, password } = settings.db;
  const sql = postgres({ host, port, user, password, database: 'postgres', max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface TestDatabase {
  name: string;
  config: DbConfig;
  drop(): Promise<void>;
}

const dropDatabase = (sql: postgres.Sql, name: string) => sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);

/** A database of its own, cloned from the template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `${CLONE_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  await withAdminConnection((sql) => sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`));
  return {
    name,
    config: { ...settings.db, name },
    drop: () => withAdminConnection(async (sql) => void (await dropDatabase(sql, name))),
  };
}

async function listDatabases(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ datname: string }[]>`select datname from pg_database`;
  return rows.map((row) => row.datname);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This run's template and clones. */
export async function dropRunDatabases(sql: postgres.Sql): Promise<void> {
  for (const name of await listDatabases(sql)) {
    if (name === TEMPLATE_DATABASE || name.startsWith(CLONE_PREFIX)) await dropDatabase(sql, name);
  }
}

/** What runs that were killed left behind. A run that is still going keeps its databases. */
export async function dropStaleDatabases(sql: postgres.Sql): Promise<void> {
  for (const name of await listDatabases(sql)) {
    const pid = TEST_DATABASE.exec(name)?.[1];
    if (pid && !isRunning(Number(pid))) await dropDatabase(sql, name);
  }
}
