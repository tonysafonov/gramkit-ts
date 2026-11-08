import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { type DbConfig, settings } from '../config';

const MIGRATIONS_FOLDER = resolve(import.meta.dirname, 'migrations');

/** Apply every pending migration. Runs on one short-lived connection, like `alembic upgrade head`. */
export async function runMigrations(config: DbConfig = settings.db): Promise<void> {
  const sql = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.name,
    max: 1,
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log('Migrations applied');
}
