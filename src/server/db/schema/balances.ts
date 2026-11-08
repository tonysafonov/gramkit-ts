import { foreignKey, pgTable, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns';
import { users } from './users';

/** Minimal per-user balance row: extend it with app-specific credits or limits. */
export const balances = pgTable(
  'balances',
  {
    userId: uuid('user_id').primaryKey(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ name: 'balances_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
  ],
);

export type Balance = typeof balances.$inferSelect;
export type NewBalance = typeof balances.$inferInsert;
