/**
 * Audit-log service: record mutating admin actions + list them for the panel.
 *
 * `record` is the single write point. It snapshots the EFFECTIVE actor identity (id / telegram id / username /
 * resolved role from the injected user): the role is never client-supplied.
 */
import type { AuditLog } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { type AdminListParams, type AdminListResponse, buildListResponse } from '../admin/schemas';
import type { UserSchema } from '../users/schemas';
import type { AuditLogFilters } from './repo';
import { type AuditLogSchema, toAuditLogSchema } from './schemas';

export class AuditLogService extends BaseService {
  /** Append an audit row for a mutating admin/owner action. */
  async record(
    actor: Pick<UserSchema, 'id' | 'telegramId' | 'username' | 'tgUsername' | 'role'>,
    action: string,
    targetType: string | null = null,
    targetId: string | null = null,
    detail: Record<string, unknown> | null = null,
  ): Promise<AuditLog> {
    return this.repos.auditLog.create({
      actorUserId: actor.id,
      actorTelegramId: actor.telegramId,
      actorUsername: actor.username || actor.tgUsername,
      actorRole: actor.role,
      action,
      targetType,
      targetId: targetId === null ? null : String(targetId),
      detail,
      createdAt: new Date(),
    });
  }

  /** Distinct audit actions recorded so far (fills the panel's action filter). */
  listActions(): Promise<string[]> {
    return this.repos.auditLog.distinctActions();
  }

  /** Paginated audit-log envelope for the admin panel. */
  async list(params: AdminListParams, filters: AuditLogFilters = {}): Promise<AdminListResponse<AuditLogSchema>> {
    const [rows, total] = await this.repos.auditLog.listFiltered(params, filters);
    return buildListResponse(rows.map(toAuditLogSchema), total, params);
  }
}
