/**
 * Admin Users service: aggregation reads + audited mutations.
 *
 * Mutations delegate to the existing domain services (subscriptions gift/cancel, payments refund) and then record an
 * audit row via `services.auditLog.record(...)`. The actor's EFFECTIVE role is whatever the injected user carries
 * (resolved server-side by RBAC), never client-supplied.
 *
 * Gating lives in the routes (admin vs owner); this service assumes the caller is authorized. Failures are domain
 * exceptions (`UserNotFoundException`, `PaymentNotFoundException`, `RefundNotAllowedException`, `ProviderRefundError`);
 * the routes map them to HTTP.
 */
import { settings } from '../../config';
import { BaseService } from '../../lib/base-service';
import { PaymentNotFoundException, UserNotFoundException } from '../../lib/errors';
import type { UserSchema } from '../users/schemas';
import {
  type AdminListParams,
  type AdminListResponse,
  type AdminPaymentListItem,
  type AdminUserDetail,
  type AdminUserListItem,
  type AdminUserSubscription,
  buildListResponse,
  type GiftDuration,
  toAdminPaymentItem,
  toAdminUserDetail,
  toAdminUserListItem,
  toAdminUserSubscription,
} from './schemas';

/** Gift duration name -> days (mirrors the Telegram /giftsub command's mapping). */
const GIFT_DURATION_DAYS: Record<GiftDuration, number> = {
  week: 7,
  month: 30,
  year: 365,
  max: 365 * 5,
};

type UserRow = Awaited<ReturnType<AdminService['requireUser']>>;

export class AdminService extends BaseService {
  // Config seam ----------------------------------------------------------------------------------------------

  /** Telegram ids forced to OWNER by config (`RBAC__OWNER_IDS`). One seam so tests can spy on it. */
  ownerIds(): Set<number> {
    return new Set(settings.rbac.ownerIds);
  }

  #isConfigOwner(user: { telegramId: number | null }): boolean {
    return user.telegramId !== null && this.ownerIds().has(user.telegramId);
  }

  // Reads ----------------------------------------------------------------------------------------------------

  async listUsers(
    params: AdminListParams,
    filters: { role?: string | undefined; userType?: string | undefined } = {},
  ): Promise<AdminListResponse<AdminUserListItem>> {
    const [rows, total] = await this.repos.adminUsers.searchUsers(params, filters);
    return buildListResponse(rows.map(toAdminUserListItem), total, params);
  }

  async getUserDetail(userId: string): Promise<AdminUserDetail | null> {
    const user = await this.repos.users.getById(userId);
    return user === null ? null : this.buildDetail(user);
  }

  /** Shape a user row into the admin detail payload (public: apps reuse it). */
  async buildDetail(user: UserRow): Promise<AdminUserDetail> {
    const activeSubscription = await this.repos.adminUsers.getActiveSubscription(user.id);
    const paymentsCount = await this.repos.adminUsers.countPayments(user.id);
    return toAdminUserDetail(user, { activeSubscription, paymentsCount, isConfigOwner: this.#isConfigOwner(user) });
  }

  async listPayments(userId: string, params: AdminListParams): Promise<AdminListResponse<AdminPaymentListItem>> {
    const [rows, total] = await this.repos.adminUsers.listPayments(userId, params);
    return buildListResponse(rows.map(toAdminPaymentItem), total, params);
  }

  async listSubscriptions(userId: string): Promise<AdminUserSubscription[]> {
    return (await this.repos.adminUsers.listSubscriptions(userId)).map(toAdminUserSubscription);
  }

  // Mutations (each writes an audit row) ----------------------------------------------------------------------

  /** Load the user or throw `UserNotFoundException` (public: apps reuse it). */
  async requireUser(userId: string) {
    const user = await this.repos.users.getById(userId);
    if (user === null) throw new UserNotFoundException('User not found');
    return user;
  }

  /** Gift (or extend) a subscription via the SHARED subscriptions method, then audit. */
  async giftSubscription(actor: UserSchema, userId: string, duration: GiftDuration): Promise<AdminUserDetail> {
    await this.requireUser(userId);
    const durationDays = GIFT_DURATION_DAYS[duration];

    const subscription = await this.services.subscriptions.giftSubscription(userId, durationDays, actor.id);

    await this.services.auditLog.record(actor, 'gift_subscription', 'user', userId, {
      duration,
      duration_days: durationDays,
      subscription_id: subscription.id,
      end_date: subscription.endDate.toISOString(),
    });
    return this.buildDetail(await this.requireUser(userId));
  }

  /** Cancel the user's active subscription (the existing cancel flow), then audit. */
  async revokeSubscription(actor: UserSchema, userId: string): Promise<AdminUserDetail> {
    await this.requireUser(userId);

    await this.services.subscriptions.cancelSubscription(userId, 'admin_revoked');

    await this.services.auditLog.record(actor, 'revoke_subscription', 'user', userId, { reason: 'admin_revoked' });
    return this.buildDetail(await this.requireUser(userId));
  }

  /**
   * Refund a Stars payment at Telegram and take back what it paid for; audited.
   *
   * The audit row is written first: the refund call at Telegram can't be undone, so nothing that can fail may run
   * after it. A payment that isn't refundable here throws `RefundNotAllowedException`; the provider refusing throws
   * `ProviderRefundError`. The route turns both into an HTTP error that leaves the request, so the request's
   * transaction rolls back and nothing is half-done. If the provider did refund (the call timed out after it), its
   * refund notice finishes the job (marks the payment and takes back what it gave).
   */
  async refundPayment(actor: UserSchema, paymentId: string): Promise<AdminPaymentListItem> {
    const payment = await this.repos.payments.getById(paymentId);
    if (payment === null) throw new PaymentNotFoundException('Payment not found');
    await this.services.auditLog.record(actor, 'refund_payment', 'user', payment.userId, {
      payment_id: payment.id,
      product_id: payment.productId,
      amount: payment.amount,
      currency: payment.currency,
      provider_id: String(payment.providerId),
    });
    return toAdminPaymentItem(await this.services.payments.refundPayment(paymentId));
  }

  /**
   * Change a user's RBAC role (owner-gated in the route), then audit.
   *
   * NOTE: if the target's telegram id is in RBAC__OWNER_IDS the change won't stick (startup sync forces OWNER); the
   * detail carries `is_config_owner` so the UI can warn. The attempt is still applied and audited.
   */
  async changeRole(actor: UserSchema, userId: string, newRole: string): Promise<AdminUserDetail> {
    const user = await this.requireUser(userId);
    const previousRole = user.role;
    const configOwner = this.#isConfigOwner(user);

    await this.repos.users.update(userId, { role: newRole });

    await this.services.auditLog.record(actor, 'change_role', 'user', userId, {
      previous_role: previousRole,
      new_role: newRole,
      config_owner: configOwner,
    });
    return this.buildDetail(await this.requireUser(userId));
  }

  /**
   * DEBUG-only hard delete (CASCADE) of a user, then audit. The route enforces DEBUG-only + owner; this is the
   * data-access + audit body. Snapshots a little target identity into the audit detail BEFORE the row is gone.
   */
  async resetUser(actor: UserSchema, userId: string): Promise<void> {
    const user = await this.requireUser(userId);
    const snapshot = { telegram_id: user.telegramId, username: user.username, role: user.role };

    await this.repos.users.delete(userId);

    await this.services.auditLog.record(actor, 'reset_user', 'user', userId, snapshot);
  }
}
