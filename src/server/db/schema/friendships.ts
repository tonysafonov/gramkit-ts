import { bigserial, boolean, foreignKey, index, pgTable, primaryKey, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { users } from './users';

export const friendships = pgTable(
  'friendships',
  {
    // In a migrated database the primary key is (user_id1, user_id2), not `id` as the Python model declares:
    // the uuid7 migration rebuilt it. `id` stays as a sequence-backed plain column.
    id: bigserial('id', { mode: 'number' }).notNull(),
    userId1: uuid('user_id1').notNull(),
    userId2: uuid('user_id2').notNull(),
    isActive: boolean('is_active')
      .notNull()
      .$default(() => true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'friendships_pkey', columns: [t.userId1, t.userId2] }),
    unique('uq_friendship').on(t.userId1, t.userId2),
    index('ix_friendships_user_id1').on(t.userId1),
    index('ix_friendships_user_id2').on(t.userId2),
    foreignKey({ name: 'friendships_user_id1_fkey', columns: [t.userId1], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'friendships_user_id2_fkey', columns: [t.userId2], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
  ],
);

export type Friendship = typeof friendships.$inferSelect;
export type NewFriendship = typeof friendships.$inferInsert;
