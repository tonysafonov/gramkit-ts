import { eq, getTableName, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../client';

export interface LockOptions {
  /** Shared lock (`FOR SHARE`): others can read and share-lock, nobody writes. Default: exclusive (`FOR UPDATE`). */
  read?: boolean;
  /** Fail immediately instead of waiting for a locked row. */
  nowait?: boolean;
  /** Skip a locked row: `null` from `getByIdWithLock`. */
  skipLocked?: boolean;
}

const lockConfig = ({ nowait, skipLocked }: LockOptions) =>
  nowait ? { noWait: true as const } : skipLocked ? { skipLocked: true as const } : {};

/**
 * The common queries of a one-table repo. Repos run inside the request's transaction and never commit.
 *
 *     class UsersRepo extends BaseRepo<typeof users> {
 *       constructor(db: Db) { super(db, users, users.id); }
 *     }
 */
export class BaseRepo<TTable extends PgTable> {
  constructor(
    protected readonly db: Db,
    protected readonly table: TTable,
    protected readonly primaryKey: AnyPgColumn,
  ) {}

  protected get tableName(): string {
    return getTableName(this.table);
  }

  private selectAll() {
    return this.db.select().from(this.table as PgTable);
  }

  async getById(id: unknown): Promise<TTable['$inferSelect'] | null> {
    const rows = await this.selectAll().where(eq(this.primaryKey, id));
    return rows[0] ?? null;
  }

  /**
   * Get a row with a pessimistic lock, held until the transaction ends. Prevents races in read-modify-write:
   * without it, two requests can both read a balance of 1 and both deduct it.
   *
   * Exclusive by default (balance deductions, any modification). `read: true` for a consistent read.
   * Returns `null` when the row doesn't exist (or is locked, with `skipLocked`).
   */
  async getByIdWithLock(id: unknown, options: LockOptions = {}): Promise<TTable['$inferSelect'] | null> {
    const rows = await this.selectAll()
      .where(eq(this.primaryKey, id))
      .for(options.read ? 'share' : 'update', lockConfig(options));
    return rows[0] ?? null;
  }

  getByIds(ids: unknown[]): Promise<TTable['$inferSelect'][]> {
    return this.selectAll().where(inArray(this.primaryKey, ids));
  }

  /** `getByIdWithLock` for several rows. */
  getByIdsWithLock(
    ids: unknown[],
    options: Pick<LockOptions, 'read' | 'nowait'> = {},
  ): Promise<TTable['$inferSelect'][]> {
    return this.selectAll()
      .where(inArray(this.primaryKey, ids))
      .for(options.read ? 'share' : 'update', lockConfig(options));
  }

  getAll(): Promise<TTable['$inferSelect'][]> {
    return this.selectAll();
  }

  async create(data: TTable['$inferInsert']): Promise<TTable['$inferSelect']> {
    const rows = (await this.db.insert(this.table).values(data).returning()) as TTable['$inferSelect'][];
    return this.single(rows);
  }

  /** Insert, or update every given column when the row conflicts on `conflictColumns`. */
  async upsert(data: TTable['$inferInsert'], conflictColumns: AnyPgColumn[]): Promise<TTable['$inferSelect']> {
    const rows = (await this.db
      .insert(this.table)
      .values(data)
      .onConflictDoUpdate({ target: conflictColumns, set: data as Record<string, unknown> })
      .returning()) as TTable['$inferSelect'][];
    return this.single(rows);
  }

  /** With no values, only `updated_at` moves, as SQLAlchemy's `onupdate` has it. */
  async update(id: unknown, data: Partial<TTable['$inferInsert']>): Promise<TTable['$inferSelect'] | null> {
    const rows = (await this.db
      .update(this.table)
      .set((Object.keys(data).length > 0 ? data : { updatedAt: sql`now()` }) as never)
      .where(eq(this.primaryKey, id))
      .returning()) as TTable['$inferSelect'][];
    return rows[0] ?? null;
  }

  async delete(id: unknown): Promise<boolean> {
    const rows = await this.db.delete(this.table).where(eq(this.primaryKey, id)).returning();
    return (rows as unknown[]).length > 0;
  }

  private single(rows: TTable['$inferSelect'][]): TTable['$inferSelect'] {
    const row = rows[0];
    if (row === undefined) throw new Error(`${this.tableName}: the write returned no row`);
    return row;
  }
}
