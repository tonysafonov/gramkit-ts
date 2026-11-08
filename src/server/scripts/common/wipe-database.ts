/**
 * Wipe all data from the database tables and Redis (reset to a fresh state). Port of
 * `core/scripts/common/wipe_database.py`.
 *
 * WARNING: deletes ALL data from ALL tables and Redis. Back up first: `backup_database`.
 *
 *     bun src/server/scripts/main.ts wipe_database
 */
import { sql } from 'drizzle-orm';
import { getLogger } from '../../lib/logging';
import type { Script, ScriptContext } from '../base';

const logger = getLogger('wipe');

/** Tables to wipe: every table in `public`, except the migration bookkeeping. */
const WIPE_EXCLUDED = ['alembic_version'];

export class WipeDatabaseScript implements Script {
  constructor(private readonly ctx: ScriptContext) {}

  async execute(): Promise<Record<string, unknown>> {
    logger.warn('='.repeat(60));
    logger.warn('WARNING: This will DELETE ALL DATA!');
    logger.warn('Make sure you have a backup!');
    logger.warn('='.repeat(60));

    const tables = await this.ctx.db.transaction(async (tx) => {
      const rows = await tx.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      const names = rows.map((row) => row.tablename).filter((name) => !WIPE_EXCLUDED.includes(name));
      if (names.length === 0) {
        logger.warn('No database tables found to wipe');
        return names;
      }
      logger.info(`Found ${names.length} tables to wipe: ${names.join(', ')}`);
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      for (const name of names) {
        try {
          // TRUNCATE is faster than DELETE and resets sequences
          await tx.execute(sql.raw(`TRUNCATE TABLE "${name.replaceAll('"', '""')}" RESTART IDENTITY CASCADE`));
          logger.info(`Wiped: ${name}`);
        } catch (err) {
          logger.error({ err }, `Failed to wipe ${name}: ${err}`);
          throw err;
        }
      }
      return names;
    });
    logger.info(`Database tables wiped successfully (${tables.length})`);

    logger.info('Wiping Redis cache...');
    await this.ctx.redis.flushdb();
    logger.info('Redis cache wiped successfully');
    logger.info('Full wipe completed: system is now in a fresh state');

    return { success: true, tables_wiped: tables.length, tables, redis_flushed: true };
  }
}
