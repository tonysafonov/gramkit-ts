import { boolean, foreignKey, integer, pgTable, primaryKey, serial, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { users } from './users';

export const groups = pgTable(
  'groups',
  {
    id: serial('id').primaryKey(),
    title: varchar('title', { length: 255 }),
    photoUrl: varchar('photo_url', { length: 255 }),
    creatorId: uuid('creator_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'groups_creator_id_fkey', columns: [t.creatorId], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    // As in `friendships`: a migrated database has the composite primary key, `id` is a plain sequence column.
    id: serial('id').notNull(),
    groupId: integer('group_id').notNull(),
    userId: uuid('user_id').notNull(),
    isAdmin: boolean('is_admin')
      .notNull()
      .$default(() => false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'group_members_pkey', columns: [t.groupId, t.userId] }),
    foreignKey({ name: 'group_members_group_id_fkey', columns: [t.groupId], foreignColumns: [groups.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'group_members_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      'cascade',
    ),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
