/**
 * Admin-panel wire shapes: the shared list convention (query params + paginated envelope), RBAC meta, and the
 * Users section. Python's `core/schemas/admin_common.py` and `admin_users.py`.
 */
import { z } from 'zod';
import type { Payment, Subscription, User } from '../../db/schema';
import type { UserSchema } from '../users/schemas';

// List convention ---------------------------------------------------------------------------------------------

/** A datetime query param as pydantic reads it: an offset-less value is taken as UTC. */
const dateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Input should be a valid datetime')
  .transform(
    (value) => new Date(/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(value) || !value.includes('T') ? value : `${value}Z`),
  );

/** The query params of every admin list endpoint (`page`, `page_size`, `sort_by`, `sort_dir`, `search`, dates). */
export const adminListShape = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  sort_by: z.string().optional(),
  sort_dir: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  date_from: dateTime.optional(),
  date_to: dateTime.optional(),
};

export const AdminListQuery = z.object(adminListShape).transform((q) => toListParams(q));

export interface AdminListParams {
  page: number;
  pageSize: number;
  sortBy?: string | undefined;
  sortDir: 'asc' | 'desc';
  search?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
}

export const toListParams = (q: {
  page: number;
  page_size: number;
  sort_by?: string | undefined;
  sort_dir: 'asc' | 'desc';
  search?: string | undefined;
  date_from?: Date | undefined;
  date_to?: Date | undefined;
}): AdminListParams => ({
  page: q.page,
  pageSize: q.page_size,
  sortBy: q.sort_by,
  sortDir: q.sort_dir,
  search: q.search,
  dateFrom: q.date_from,
  dateTo: q.date_to,
});

export const offsetOf = (params: AdminListParams): number => (params.page - 1) * params.pageSize;

export interface AdminListResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/** The envelope from the filtered rows, the unpaginated total and the params. */
export function buildListResponse<T>(items: T[], total: number, params: AdminListParams): AdminListResponse<T> {
  return {
    items,
    total,
    page: params.page,
    page_size: params.pageSize,
    total_pages: params.pageSize ? Math.ceil(total / params.pageSize) : 0,
  };
}

// RBAC meta ---------------------------------------------------------------------------------------------------

export interface AdminRbac {
  role: string;
  is_admin: boolean;
  is_owner: boolean;
  can_perform_destructive: boolean;
}

export const toAdminRbac = (user: Pick<UserSchema, 'role'>): AdminRbac => {
  const isOwner = user.role === 'owner';
  return {
    role: user.role,
    is_admin: user.role === 'admin' || isOwner,
    is_owner: isOwner,
    can_perform_destructive: isOwner,
  };
};

// Users section -----------------------------------------------------------------------------------------------

export const GIFT_DURATIONS = ['week', 'month', 'year', 'max'] as const;
export type GiftDuration = (typeof GIFT_DURATIONS)[number];

export const GiftSubscriptionRequest = z.object({ duration: z.enum(GIFT_DURATIONS) });
export const ChangeRoleRequest = z.object({ new_role: z.enum(['user', 'admin', 'owner']) });

export const AdminUsersQuery = z
  .object({ ...adminListShape, role: z.string().optional(), user_type: z.string().optional() })
  .transform((q) => ({ params: toListParams(q), role: q.role, userType: q.user_type }));

export const UserIdParam = z.object({ user_id: z.uuid() });
export const PaymentIdParam = z.object({ payment_id: z.uuid() });

export interface AdminUserListItem {
  id: string;
  user_type: string;
  role: string;
  username: string | null;
  display_name: string | null;
  telegram_id: number | null;
  tg_username: string | null;
  email: string | null;
  current_streak: number;
  best_streak: number;
  total_active_days: number;
  last_activity_date: string | null;
  is_onboarded: boolean | null;
  created_at: Date | null;
}

export interface AdminUserSubscription {
  id: string;
  product_id: string;
  provider_id: string;
  status: string;
  currency: string;
  start_date: Date;
  end_date: Date;
  canceled_at: Date | null;
  cancellation_reason: string | null;
}

export interface AdminUserDetail {
  id: string;
  user_type: string;
  role: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  language_code: string | null;
  timezone: string | null;
  birth_date: string | null;
  male: boolean | null;
  telegram_id: number | null;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_is_premium: boolean | null;
  email: string | null;
  email_verified: boolean;
  current_streak: number;
  best_streak: number;
  total_active_days: number;
  last_activity_date: string | null;
  is_onboarded: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  active_subscription: AdminUserSubscription | null;
  has_active_subscription: boolean;
  payments_count: number;
  is_config_owner: boolean;
}

export interface AdminPaymentListItem {
  id: string;
  product_id: string;
  provider_id: string;
  amount: number;
  currency: string;
  status: string;
  is_recurring: boolean;
  created_at: Date | null;
}

type UserRow = Omit<User, 'passwordHash'>;

export const toAdminUserListItem = (u: UserRow): AdminUserListItem => ({
  id: u.id,
  user_type: u.userType,
  role: u.role,
  username: u.username,
  display_name: u.displayName,
  telegram_id: u.telegramId,
  tg_username: u.tgUsername,
  email: u.email,
  current_streak: u.currentStreak,
  best_streak: u.bestStreak,
  total_active_days: u.totalActiveDays,
  last_activity_date: u.lastActivityDate,
  is_onboarded: u.isOnboarded,
  created_at: u.createdAt,
});

export const toAdminUserSubscription = (s: Subscription): AdminUserSubscription => ({
  id: s.id,
  product_id: s.productId,
  provider_id: String(s.providerId),
  status: s.status,
  currency: s.currency,
  start_date: s.startDate,
  end_date: s.endDate,
  canceled_at: s.canceledAt,
  cancellation_reason: s.cancellationReason,
});

export const toAdminPaymentItem = (p: Payment): AdminPaymentListItem => ({
  id: p.id,
  product_id: p.productId,
  provider_id: String(p.providerId),
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  is_recurring: p.isRecurring,
  created_at: p.createdAt,
});

export const toAdminUserDetail = (
  u: UserRow,
  extra: { activeSubscription: Subscription | null; paymentsCount: number; isConfigOwner: boolean },
): AdminUserDetail => ({
  id: u.id,
  user_type: u.userType,
  role: u.role,
  username: u.username,
  display_name: u.displayName,
  avatar_url: u.avatarUrl,
  language_code: u.languageCode,
  timezone: u.timezone,
  birth_date: u.birthDate,
  male: u.male,
  telegram_id: u.telegramId,
  tg_username: u.tgUsername,
  tg_first_name: u.tgFirstName,
  tg_is_premium: u.tgIsPremium,
  email: u.email,
  email_verified: u.emailVerified,
  current_streak: u.currentStreak,
  best_streak: u.bestStreak,
  total_active_days: u.totalActiveDays,
  last_activity_date: u.lastActivityDate,
  is_onboarded: u.isOnboarded,
  created_at: u.createdAt,
  updated_at: u.updatedAt,
  active_subscription: extra.activeSubscription ? toAdminUserSubscription(extra.activeSubscription) : null,
  has_active_subscription: extra.activeSubscription !== null,
  payments_count: extra.paymentsCount,
  is_config_owner: extra.isConfigOwner,
});
