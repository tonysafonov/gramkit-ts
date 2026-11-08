import { and, count, eq, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type AuditLog, adminAuditLogs } from '../../db/schema';
import { adminListOrder, adminListWhere } from '../admin/list';
import { type AdminListParams, offsetOf } from '../admin/schemas';

// First entry = default sort.
const SORTABLE = { created_at: adminAuditLogs.createdAt, action: adminAuditLogs.action };
const SEARCHABLE = [adminAuditLogs.action, adminAuditLogs.targetType];

export interface AuditLogFilters {
  action?: string | undefined;
  actorUserId?: string | undefined;
  targetUserId?: string | undefined;
}

export class AuditLogRepo extends BaseRepo<typeof adminAuditLogs> {
  constructor(db: Db) {
    super(db, adminAuditLogs, adminAuditLogs.id);
  }

  /** Every distinct `action` recorded so far, alphabetically (for the action filter). */
  async distinctActions(limit = 200): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ action: adminAuditLogs.action })
      .from(adminAuditLogs)
      .orderBy(adminAuditLogs.action)
      .limit(limit);
    return rows.map((row) => row.action);
  }

  /**
   * Filtered + paginated audit rows plus the unpaginated total. The optional filters narrow to a specific action,
   * actor, or target before the generic search/date/sort/paginate is applied.
   */
  async listFiltered(
    params: AdminListParams,
    { action, actorUserId, targetUserId }: AuditLogFilters = {},
  ): Promise<[AuditLog[], number]> {
    const where = adminListWhere(
      params,
      { searchable: SEARCHABLE, dateColumn: adminAuditLogs.createdAt },
      action === undefined ? undefined : eq(adminAuditLogs.action, action),
      actorUserId === undefined ? undefined : eq(adminAuditLogs.actorUserId, actorUserId),
      targetUserId === undefined
        ? undefined
        : and(eq(adminAuditLogs.targetType, 'user'), eq(adminAuditLogs.targetId, targetUserId)),
    );
    const rows = await this.db
      .select()
      .from(adminAuditLogs)
      .where(where)
      .orderBy(adminListOrder(params, SORTABLE) as SQL)
      .limit(params.pageSize)
      .offset(offsetOf(params));
    const [totalRow] = await this.db.select({ total: count() }).from(adminAuditLogs).where(where);
    return [rows, totalRow?.total ?? 0];
  }
}
