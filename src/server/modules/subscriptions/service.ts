import type { Bot } from 'grammy';
import type { RabbitProducer } from '../../clients/rabbit';
import { type Payment, PaymentProvider, PaymentStatus, type Subscription, SubscriptionStatus } from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import { esc, fmtAgo, fmtDate, fmtMoney, fmtMoneyMap, tags, userRef, userTag } from '../messages/admin-messages';
import type { ProductCatalog } from '../payments/products';
import type { RecurringDetails } from '../payments/types';
import { addDays, daysBetween, errorMessage } from '../payments/utils';
import type { UserSchema } from '../users/schemas';
import {
  getMockSubscription,
  type SubscriptionSchema,
  type SubscriptionWithDetailsSchema,
  toSubscriptionSchema,
} from './schemas';

const logger = getLogger('subscriptions');

const REASON_LABELS: Record<string, string> = {
  tooExpensive: 'Too expensive',
  notUsing: 'Not using',
  foundAlternative: 'Found alternative',
  technicalIssues: 'Technical issues',
  other: 'Other',
};

export class SubscriptionsService extends BaseService {
  constructor(
    repos: Repos,
    producer: RabbitProducer,
    services: Services,
    bot: Bot | null,
    readonly products: ProductCatalog,
  ) {
    super(repos, producer, services, bot);
  }

  private productLabel(productId: string): string {
    return esc(this.products.getProduct(productId)?.name ?? productId);
  }

  /** 'joined 3d ago · 2 payments · LTV 798 ₽': who this customer is, at a glance. */
  private async adminUserContext(user: UserSchema): Promise<string> {
    const payments = (await this.repos.payments.getByUserId(user.id)).filter(
      (p) => p.status === PaymentStatus.SUCCEEDED,
    );
    const ltv: Record<string, number> = {};
    for (const p of payments) ltv[p.currency] = (ltv[p.currency] ?? 0) + p.amount;
    const total = payments.length;
    return `joined ${fmtAgo(user.createdAt)} · ${total} payment${total !== 1 ? 's' : ''} · LTV ${fmtMoneyMap(ltv)}`;
  }

  // To the frontend

  async getSubscriptionForUser(userId: string): Promise<SubscriptionSchema> {
    const subscription = await this.repos.subscriptions.getActiveByUserId(userId);
    return subscription ? toSubscriptionSchema(subscription) : getMockSubscription(userId);
  }

  /** `canceled*` stay empty here, as they do in Python's details schema. */
  async getSubscriptionWithDetailsForUser(userId: string): Promise<SubscriptionWithDetailsSchema> {
    const subscription = await this.repos.subscriptions.getActiveByUserId(userId);
    const noCancellation = { canceledAt: null, cancellationReason: null, cancellationFeedback: null };
    if (subscription) {
      let productPrice = 0;
      if (subscription.productId !== 'GIFT_SUB') {
        const product = this.products.getProduct(subscription.productId);
        if (!product) logger.error(`Product ${subscription.productId} not found`);
        else productPrice = product.getPriceFor(subscription.currency).amount;
      }
      return {
        ...toSubscriptionSchema(subscription),
        ...noCancellation,
        productPrice,
        providerId: subscription.providerId,
        currency: subscription.currency,
      };
    }

    const weeklyProduct = this.products.getProduct('WEEK_SUB_V2'); // the newer product's price, for the mock
    return {
      ...getMockSubscription(userId),
      ...noCancellation,
      productPrice: weeklyProduct ? weeklyProduct.getPriceFor('USD').amount : 1.99,
      providerId: PaymentProvider.GIFT,
      currency: 'USD',
    };
  }

  async hasActiveSubscription(userId: string): Promise<boolean> {
    const subscription = await this.repos.subscriptions.getActiveByUserId(userId);
    return (
      subscription !== null &&
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.PAST_DUE ||
        subscription.status === SubscriptionStatus.CANCELED)
    );
  }

  // Inside the payments service

  async topUpSubscription(
    userId: string,
    _productId: string,
    durationDays: number,
    payment: Payment,
    recurringDetails: RecurringDetails,
  ): Promise<Subscription> {
    logger.info(
      `Topping up subscription for user ${userId} with product ${payment.productId} after payment ${payment.id}`,
    );
    const now = new Date();
    let subscription = await this.repos.subscriptions.getActiveByUserId(userId);
    // Fallback: expired-but-still-ACTIVE subs (e.g. after downtime). Prevents a duplicate sub and an old one recharged.
    subscription ??= await this.repos.subscriptions.getRenewableByUserId(userId);

    // Resurrection backstop for the no-sub-found case: a late auto-renewal can land just after a canceled sub's end
    // date, when neither lookup above sees it. Without this, the renewal would create a brand-new ACTIVE sub,
    // resurrecting what the user canceled. (Only auto-renewals carry `is_renewal`; a deliberate re-purchase falls
    // through to reactivate normally.)
    if (!subscription && recurringDetails.is_renewal) {
      const recentlyCanceled = await this.repos.subscriptions.getRecentlyCanceledByUserId(userId, addDays(now, -45));
      if (recentlyCanceled) {
        logger.warn(
          `Ignoring auto-renewal for recently-canceled subscription ${recentlyCanceled.id} (payment ${payment.id}); not resurrecting past end_date`,
        );
        await this.repos.payments.update(payment.id, { subscriptionId: recentlyCanceled.id });
        return recentlyCanceled;
      }
    }

    let isRenewal = false;

    // Always the product id from the payment record
    const actualProductId = payment.productId;

    if (subscription) {
      // Resurrection guard: a user-CANCELED subscription still inside its paid window must NOT be flipped back to
      // ACTIVE by a late or in-flight provider auto-renewal (e.g. a Telegram Star debit that fired before our cancel
      // propagated). Only genuine auto-renewals are blocked: a user actively re-purchasing reuses this same row and
      // SHOULD reactivate it.
      if (subscription.status === SubscriptionStatus.CANCELED && recurringDetails.is_renewal) {
        logger.warn(
          `Ignoring auto-renewal for canceled subscription ${subscription.id} (payment ${payment.id}); not resurrecting`,
        );
        await this.repos.payments.update(payment.id, { subscriptionId: subscription.id });
        return subscription;
      }

      isRenewal = true;
      const currentEndDate = subscription.endDate > now ? subscription.endDate : now;
      const mergedDetails = { ...subscription.recurringDetails, ...recurringDetails }; // new values override
      const updated = await this.repos.subscriptions.update(subscription.id, {
        productId: actualProductId,
        providerId: payment.providerId,
        currency: payment.currency,
        status: SubscriptionStatus.ACTIVE,
        endDate: addDays(currentEndDate, durationDays),
        recurringDetails: mergedDetails,
        paymentMethodId: (mergedDetails.payment_method_id as string | undefined) || subscription.paymentMethodId,
      });
      subscription = updated ?? subscription;
    } else {
      subscription = await this.repos.subscriptions.create({
        userId,
        productId: actualProductId,
        providerId: payment.providerId,
        currency: payment.currency,
        status: SubscriptionStatus.ACTIVE,
        startDate: now,
        endDate: addDays(now, durationDays),
        recurringDetails,
        paymentMethodId: (recurringDetails.payment_method_id as string | undefined) ?? null,
      });
    }
    await this.repos.payments.update(payment.id, { subscriptionId: subscription.id });
    // For purchases made before onboarding finished
    const user = await this.services.users.updateUser(userId, { isOnboarded: true });

    const amount = esc(fmtMoney(payment.amount, payment.currency));
    const context = await this.adminUserContext(user);
    if (isRenewal) {
      await this.services.messages.queueAdminBroadcast(
        `🔁 <b>Renewal · ${amount}</b>\n` +
          `${this.productLabel(actualProductId)} · ${userRef(user)}\n` +
          `<i>${context} · until ${fmtDate(subscription.endDate)}</i>\n` +
          `${tags('renewal', userTag(user))}`,
      );
    } else {
      await this.services.messages.queueAdminBroadcast(
        `💰 <b>Purchase · ${amount}</b>\n` +
          `${this.productLabel(actualProductId)} · ${userRef(user)}\n` +
          `<i>${context}</i>\n` +
          `${tags('purchase', userTag(user))}`,
      );
    }

    return subscription;
  }

  /**
   * Grant (or extend) a free GIFT subscription for `durationDays`.
   *
   * Shared by the Telegram `/giftsub` command and the admin web endpoint so the two paths produce identical state: an
   * entitled subscription with a future end date is EXTENDED and forced ACTIVE; otherwise a fresh GIFT_SUB/GIFT
   * subscription runs from now. Also flips `isOnboarded` (a gift unblocks onboarding-gated users).
   */
  async giftSubscription(
    userId: string,
    durationDays: number,
    giftedBy: string | null = null,
  ): Promise<SubscriptionSchema> {
    const now = new Date();
    const subscription = await this.repos.subscriptions.getActiveByUserId(userId);

    let gifted: Subscription;
    if (subscription && subscription.endDate > now) {
      const updated = await this.repos.subscriptions.update(subscription.id, {
        endDate: addDays(subscription.endDate, durationDays),
        status: SubscriptionStatus.ACTIVE,
      });
      gifted = updated ?? subscription;
    } else {
      gifted = await this.repos.subscriptions.create({
        userId,
        productId: 'GIFT_SUB',
        providerId: PaymentProvider.GIFT,
        status: SubscriptionStatus.ACTIVE,
        currency: 'RUB',
        startDate: now,
        endDate: addDays(now, durationDays),
        recurringDetails: giftedBy ? { gifted_by: giftedBy } : {},
      });
    }

    await this.services.users.updateUser(userId, { isOnboarded: true });
    return toSubscriptionSchema(gifted);
  }

  async cancelSubscription(
    userId: string,
    reason: string | null = null,
    feedback: string | null = null,
  ): Promise<SubscriptionSchema> {
    const active = await this.repos.subscriptions.getActiveByUserId(userId);
    if (!active) return getMockSubscription(userId);

    const updated = await this.repos.subscriptions.update(active.id, {
      status: SubscriptionStatus.CANCELED,
      canceledAt: new Date(),
      cancellationReason: reason,
      cancellationFeedback: feedback,
    });
    const subscription = updated ?? active;

    // Best-effort: tell the provider to stop future renewals (Telegram Stars debits on its own schedule, so a DB-only
    // cancel would keep getting charged). Never let a provider failure block the user's cancel: the row is already
    // CANCELED and the topUpSubscription resurrection guard protects entitlement if this didn't land.
    try {
      await this.services.payments.cancelProviderSubscription(subscription);
    } catch (err) {
      logger.error(
        { err },
        `Failed to cancel subscription ${subscription.id} at provider ${subscription.providerId}: ${errorMessage(err)}`,
      );
      await this.services.messages.queueAdminBroadcast(
        `🚨 <b>Cancel not propagated to ${esc(subscription.providerId)}</b>\n` +
          `Subscription <code>${subscription.id}</code> is CANCELED in our DB, but the provider ` +
          `call failed — check it won't keep charging.\n` +
          `<pre>${esc(errorMessage(err))}</pre>\n` +
          `${tags('critical', 'cancel')}`,
      );
    }

    const user = await this.services.users.getUserById(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    let message =
      `🚫 <b>Canceled · ${this.productLabel(subscription.productId)}</b>\n` +
      `${userRef(user)} · subscribed ${daysBetween(subscription.startDate, new Date())} days, ` +
      `access until ${fmtDate(subscription.endDate)}\n` +
      `<i>${await this.adminUserContext(user)}</i>`;
    if (reason) message += `\nReason: <b>${esc(REASON_LABELS[reason] ?? reason)}</b>`;
    if (feedback) message += `\n<blockquote>${esc(feedback)}</blockquote>`;
    message += `\n${tags('cancel', userTag(user))}`;

    await this.services.messages.queueAdminBroadcast(message);
    return toSubscriptionSchema(subscription);
  }
}
