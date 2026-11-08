import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type DbConfig, settings } from '../config';
import * as schema from './schema';

type Schema = typeof schema;
type Relations = ExtractTablesWithRelations<Schema>;

/** What a repo takes: the pool or an open transaction. */
export type Db = PgDatabase<PostgresJsQueryResultHKT, Schema, Relations>;
export type Tx = PgTransaction<PostgresJsQueryResultHKT, Schema, Relations>;
export type Database = PostgresJsDatabase<Schema>;

export interface DbClient {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

const RECYCLE_AFTER_SECONDS = 1800;
const CONNECT_TIMEOUT_SECONDS = 30;
const POOL_TIMEOUT_SECONDS = 30;

/**
 * One pool per process (HTTP worker, bot, BullMQ worker), `poolSize` connections, no overflow. Connections open on
 * demand and are recycled after 30 minutes. A request past the pool waits up to 30 seconds for a free connection
 * (SQLAlchemy's `pool_timeout`), then fails with `QUEUE_TIMEOUT`.
 */
export function createDb(config: DbConfig = settings.db): DbClient {
  const sql = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.name,
    max: config.poolSize,
    max_lifetime: RECYCLE_AFTER_SECONDS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    queue_timeout: POOL_TIMEOUT_SECONDS,
    onnotice: () => {},
  });
  return {
    sql,
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}
