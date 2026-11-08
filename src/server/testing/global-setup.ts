/** Vitest global setup: builds this run's template database, and removes this run's test databases after it. */
process.env.ENV_FILE ??= '.env.test';
process.env.GRAMKIT_TEST_RUN = String(process.pid);

export default async function setup() {
  const { settings } = await import('../config');
  const { runMigrations } = await import('../db/migrate');
  const { dropRunDatabases, dropStaleDatabases, TEMPLATE_DATABASE, withAdminConnection } = await import('./database');

  await withAdminConnection(async (sql) => {
    await dropStaleDatabases(sql);
    await sql.unsafe(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  });
  await runMigrations({ ...settings.db, name: TEMPLATE_DATABASE });

  return () => withAdminConnection(dropRunDatabases);
}
