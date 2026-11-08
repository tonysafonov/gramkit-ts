import { bigint, foreignKey, index, jsonb, pgTable, serial, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { users } from './users';

/**
 * Append-only audit trail of mutating admin/owner actions. Actor identity is snapshotted so the row stays meaningful
 * after the user is edited or deleted; `targetId` is a plain string, it must survive whatever it points at.
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: serial('id').primaryKey(),
    actorUserId: uuid('actor_user_id'),
    actorTelegramId: bigint('actor_telegram_id', { mode: 'number' }),
    actorUsername: varchar('actor_username', { length: 128 }),
    actorRole: varchar('actor_role', { length: 20 }).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 64 }),
    targetId: varchar('target_id', { length: 64 }),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_admin_audit_logs_created_at').on(t.createdAt),
    index('ix_admin_audit_logs_actor_user_id').on(t.actorUserId),
    index('ix_admin_audit_logs_action').on(t.action),
    foreignKey({
      name: 'admin_audit_logs_actor_user_id_fkey',
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);

export type AuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAuditLog = typeof adminAuditLogs.$inferInsert;
