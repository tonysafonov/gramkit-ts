import { z } from 'zod';
import type { AuditLog } from '../../db/schema';
import { adminListShape, toListParams } from '../admin/schemas';

export interface AuditLogSchema {
  id: number;
  actor_user_id: string | null;
  actor_telegram_id: number | null;
  actor_username: string | null;
  actor_role: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

export const toAuditLogSchema = (row: AuditLog): AuditLogSchema => ({
  id: row.id,
  actor_user_id: row.actorUserId,
  actor_telegram_id: row.actorTelegramId,
  actor_username: row.actorUsername,
  actor_role: row.actorRole,
  action: row.action,
  target_type: row.targetType,
  target_id: row.targetId,
  detail: row.detail,
  created_at: row.createdAt,
});

/** The list query: the shared admin list params plus the audit filters. */
export const AuditLogQuery = z
  .object({
    ...adminListShape,
    action: z.string().optional(),
    actor_user_id: z.uuid().optional(),
    target_user_id: z.string().optional(),
  })
  .transform((q) => ({
    params: toListParams(q),
    action: q.action,
    actorUserId: q.actor_user_id,
    targetUserId: q.target_user_id,
  }));
