import { sql } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';

/** `TIMESTAMP WITH TIME ZONE`, read as a `Date` (UTC instant). */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** CreatedAtMixin: DB clock, set on insert. */
export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/** UpdatedAtMixin: DB clock on insert, and on every Drizzle update (SQLAlchemy `onupdate=func.now()`). */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`);
