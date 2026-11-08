import { randomBytes } from 'node:crypto';
import { foreignKey, integer, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from './columns';
import { groups } from './groups';
import { users } from './users';

export const groupInvites = pgTable(
  'group_invites',
  {
    // 6 bytes = 12 hex chars
    code: varchar('code', { length: 12 })
      .primaryKey()
      .$defaultFn(() => randomBytes(6).toString('hex')),
    creatorId: uuid('creator_id').notNull(),
    groupId: integer('group_id').notNull(),
    usedCount: integer('used_count')
      .notNull()
      .$default(() => 0),
    expiresAt: timestamptz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('group_invites_code_key').on(t.code),
    foreignKey({ name: 'group_invites_creator_id_fkey', columns: [t.creatorId], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'group_invites_group_id_fkey', columns: [t.groupId], foreignColumns: [groups.id] }).onDelete(
      'cascade',
    ),
  ],
);

export type GroupInvite = typeof groupInvites.$inferSelect;
export type NewGroupInvite = typeof groupInvites.$inferInsert;
