/**
 * Read-only repository for the admin Users section: search/filter/paginate over `users`, plus the per-user payment and
 * subscription sub-lists and the detail rollups. `sort_by` is whitelisted (never interpolated).
 *
 * App-specific per-user data lives in an app repo next to its own admin endpoints, not here.
 */
import { and, count, desc, eq, getTableColumns, gt, inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import {
  type Payment,
  payments,
  type Subscription,
  SubscriptionStatus,
  subscriptions,
  type User,
  type UserType,
  users,
} from '../../db/schema';
import { adminListOrder, adminListWhere } from './list';
import { type AdminListParams, offsetOf } from './schemas';

type UserRow = Omit<User, 'passwordHash'>;

// First entry = default sort.
const USER_SORTABLE = {
  created_at: users.createdAt,
  updated_at: users.updatedAt,
  current_streak: users.currentStreak,
  best_streak: users.bestStreak,
  total_active_days: users.totalActiveDays,
  username: users.username,
  role: users.role,
};
// The password hash never leaves the repo layer.
const { passwordHash: _passwordHash, ...USER_COLUMNS } = getTableColumns(users);
const USER_SEARCHABLE = [users.username, users.tgUsername, users.displayName, users.email];

const PAYMENT_SORTABLE = { created_at: payments.createdAt, amount: payments.amount, status: payments.status };

export class AdminUsersRepo extends BaseRepo<typeof users> {
  constructor(db: Db) {
    super(db, users, users.id);
  }

  /**
   * Filtered + paginated user rows plus the unpaginated total. Free-text search is ILIKE across the searchable
   * columns; `role` / `userType` are exact filters.
   */
  async searchUsers(
    params: AdminListParams,
    { role, userType }: { role?: string | undefined; userType?: string | undefined } = {},
  ): Promise<[UserRow[], number]> {
    const where = adminListWhere(
      params,
      { searchable: USER_SEARCHABLE, dateColumn: users.createdAt },
      role === undefined ? undefined : eq(users.role, role),
      userType === undefined ? undefined : eq(users.userType, userType as UserType),
    );
    const rows = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(where)
      .orderBy(adminListOrder(params, USER_SORTABLE) as SQL)
      .limit(params.pageSize)
      .offset(offsetOf(params));
    const [totalRow] = await this.db.select({ total: count() }).from(users).where(where);
    return [rows, totalRow?.total ?? 0];
  }

  // Per-user sub-lists ----------------------------------------------------------------------------------------

  async listPayments(userId: string, params: AdminListParams): Promise<[Payment[], number]> {
    const where = adminListWhere(params, { dateColumn: payments.createdAt }, eq(payments.userId, userId));
    const rows = await this.db
      .select()
      .from(payments)
      .where(where)
      .orderBy(adminListOrder(params, PAYMENT_SORTABLE) as SQL)
      .limit(params.pageSize)
      .offset(offsetOf(params));
    const [totalRow] = await this.db.select({ total: count() }).from(payments).where(where);
    return [rows, totalRow?.total ?? 0];
  }

  listSubscriptions(userId: string): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.startDate));
  }

  // Detail aggregation helpers ----------------------------------------------------------------------------------

  /**
   * The user's current entitled subscription, if any: ACTIVE, PAST_DUE or CANCELED (a canceled sub runs to its end
   * date) with `endDate` still in the future. Latest-ending first.
   */
  async getActiveSubscription(userId: string): Promise<Subscription | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
            SubscriptionStatus.CANCELED,
          ]),
          gt(subscriptions.endDate, new Date()),
        ),
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);
    return rows[0] ?? null;
  }

  async countPayments(userId: string): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(payments).where(eq(payments.userId, userId));
    return row?.total ?? 0;
  }
}
