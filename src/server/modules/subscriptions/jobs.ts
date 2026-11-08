/** Subscription background jobs: charging and expiring. Port of `core/infrastructure/arq/jobs/subscriptions.py`. */
import { posthog } from '../../clients/posthog';
import { PaymentEventType, PaymentProvider, PaymentStatus, SubscriptionStatus } from '../../db/schema';
import { getLogger } from '../../lib/logging';
import type { Services } from '../../services';
import { bulletList, esc, tags, userRef, userTag } from '../messages/admin-messages';
import { products as appProducts, type ProductCatalog } from '../payments/products';
import { isNativeStarsSubscription } from '../payments/providers/telegram-stars';
import { buildPaymentRequest, renewalIdempotencyKey } from '../payments/providers/yookassa';
import { yookassaPayments } from '../payments/providers/yookassa-api';
import type { Json } from '../payments/types';
import { daysBetween, errorMessage } from '../payments/utils';

const logger = getLogger('subscription-jobs');

const HOUR_MS = 3_600_000;

// Dunning tuning. The renewal job runs several times a day; RENEWAL_RETRY_SPACING throttles a declining card to about
// one real attempt a day, so MAX_RENEWAL_ATTEMPTS spreads over ~3 days of grace.
export const MAX_RENEWAL_ATTEMPTS = 3;
export const RENEWAL_RETRY_SPACING_MS = 20 * HOUR_MS;
/** A non-terminal renewal row older than this is stranded (worker died mid-flow), not a concurrent in-flight attempt. */
export const RECOVERY_STALE_AFTER_MS = HOUR_MS / 2;
/** Hard entitlement ceiling for a PAST_DUE sub: expired once end date + this has passed. */
export const GRACE_PERIOD_MS = 4 * 24 * HOUR_MS;

/** What these jobs need from the worker's context: a transaction with services. */
export interface SubscriptionJobContext {
  withTransaction<T>(fn: (services: Services) => Promise<T>): Promise<T>;
}

export interface ChargeResults {
  success: number;
  failed: number;
  skipped: number;
  past_due: number;
  dunning_expired: number;
  recovered: number;
}

type DunningEvent =
  | { userId: string; kind: 'recovered' }
  | { userId: string; kind: 'past_due'; count: number }
  | { userId: string; kind: 'expired'; count: number; reason: string };

/** SQLAlchemy's `IntegrityError`: a Postgres class 23 error, wrapped by Drizzle. */
function isIntegrityError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && code.length === 5 && code.startsWith('23')) return true;
  }
  return false;
}

async function requireUser(services: Services, userId: string) {
  const user = await services.users.getUserById(userId);
  if (!user) throw new Error(`User ${userId} not found`);
  return user;
}

/**
 * Charge expiring subscriptions with split transactions and a dunning state machine.
 *
 * Per subscription: a transaction creates the payment record, the YooKassa call runs with no transaction open, a
 * second transaction saves the result and advances the dunning state.
 *
 * Dunning: a declined renewal moves the sub to PAST_DUE (still entitled, in grace) and is retried about once a day up
 * to MAX_RENEWAL_ATTEMPTS; a hard decline (permission_revoked) or an exhausted budget expires it. A success resets the
 * counter back to ACTIVE. A bare transport exception does NOT advance dunning (the card may have been charged): it only
 * stamps the attempt time so recovery resolves it on the next run.
 */
export async function chargeExpiringSubscriptionsJob(
  ctx: SubscriptionJobContext,
  products: ProductCatalog = appProducts,
): Promise<ChargeResults> {
  logger.info('Job started: charge_expiring_subscriptions');
  const now = new Date();
  const expirationThreshold = new Date(now.getTime() + 24 * HOUR_MS);

  const expiringSubs = await ctx.withTransaction((services) =>
    services.repos.subscriptions.getChargeableSubscriptions(expirationThreshold),
  );

  const manuallyChargedSubs = expiringSubs.filter(
    (sub) => sub.providerId !== PaymentProvider.GIFT && sub.providerId !== PaymentProvider.TELEGRAM_STARS,
  );
  const telegramStarsSubs = expiringSubs.filter((sub) => sub.providerId === PaymentProvider.TELEGRAM_STARS);

  logger.info(
    `Found ${expiringSubs.length} chargeable subscriptions: ${manuallyChargedSubs.length} manual, ${telegramStarsSubs.length} Telegram Stars managed`,
  );

  const results: ChargeResults = { success: 0, failed: 0, skipped: 0, past_due: 0, dunning_expired: 0, recovered: 0 };
  const dunningEvents: DunningEvent[] = []; // consolidated admin summary of dunning transitions

  for (const subscription of manuallyChargedSubs) {
    let paymentId: string | null = null;
    const wasPastDue = subscription.status === SubscriptionStatus.PAST_DUE;
    try {
      logger.info(`Processing subscription ${subscription.id} (provider: ${subscription.providerId})`);
      const product = products.getProduct(subscription.productId);

      if (!product) {
        logger.warn(`Product ${subscription.productId} not found in catalog, skipping subscription ${subscription.id}`);
        results.skipped += 1;
        continue;
      }

      // Retry spacing: a PAST_DUE card retried within the window is left for the next day, so a job running several
      // times a day doesn't hammer a declining card.
      if (
        wasPastDue &&
        subscription.lastRenewalAttemptAt &&
        now.getTime() - subscription.lastRenewalAttemptAt.getTime() < RENEWAL_RETRY_SPACING_MS
      ) {
        logger.info(`Subscription ${subscription.id} retried within spacing window; skipping this run`);
        results.skipped += 1;
        continue;
      }

      // Deterministic key for this (subscription, billing period): a re-fired renewal reuses it, so a concurrent
      // double-create is rejected by uq_payment_idempotency_key and a same-period retry is deduped by YooKassa.
      const renewalKey = renewalIdempotencyKey(subscription.id, subscription.endDateExact);

      const { alreadyCharged, stranded } = await ctx.withTransaction(async (services) => ({
        alreadyCharged: await services.repos.payments.getSucceededRenewalForPeriod(renewalKey),
        stranded: await services.repos.payments.getNonterminalRenewalForPeriod(renewalKey),
      }));

      // Dedup: a SUCCEEDED renewal for this period means don't charge again. A prior FAILED attempt does NOT block
      // here: the dunning budget must be able to retry it.
      if (alreadyCharged) {
        logger.info(
          `Subscription ${subscription.id} already has a SUCCEEDED renewal (payment ${alreadyCharged.id}) for end_date ${subscription.endDate.toISOString()}; skipping`,
        );
        results.skipped += 1;
        continue;
      }

      // Recover a renewal stranded mid-flow: a non-terminal row still holds the period key (blocking a fresh insert via
      // the unique index). Fresh: a concurrent run owns it, skip. Stale: the worker died after create; mark it FAILED so
      // we can re-attempt (the deterministic key keeps the re-charge idempotent on YooKassa's side).
      if (stranded) {
        if (now.getTime() - stranded.createdAt.getTime() < RECOVERY_STALE_AFTER_MS) {
          logger.info(`Subscription ${subscription.id}: renewal in flight (payment ${stranded.id}); skipping`);
          results.skipped += 1;
          continue;
        }
        logger.warn(
          `Recovering stranded renewal ${stranded.id} for subscription ${subscription.id} (key ${renewalKey})`,
        );
        try {
          await ctx.withTransaction((services) =>
            services.repos.payments.update(stranded.id, {
              status: PaymentStatus.FAILED,
              providerMetadata: { recovered: 'stranded_mid_flow' },
            }),
          );
        } catch (recoverError) {
          // If the stranded row can't be marked FAILED, the unique index still blocks a fresh insert: skip this period
          // and retry next run rather than crashing the loop.
          logger.error(`Failed to recover stranded renewal ${stranded.id}: ${errorMessage(recoverError)}`);
          results.skipped += 1;
          continue;
        }
      }

      // Transaction 2a: create the payment record
      const { amount } = product.getPriceFor(subscription.currency);
      let payment: Awaited<ReturnType<Services['repos']['payments']['create']>>;
      try {
        payment = await ctx.withTransaction(async (services) => {
          const created = await services.repos.payments.create({
            userId: subscription.userId,
            productId: subscription.productId,
            providerId: subscription.providerId,
            amount,
            currency: subscription.currency,
            status: PaymentStatus.CREATED,
            idempotencyKey: renewalKey,
            isRecurring: true,
            providerPaymentId: null,
            providerMetadata: {},
          });
          await services.repos.paymentEvents.create({
            paymentId: created.id,
            providerId: subscription.providerId,
            eventType: PaymentEventType.PAYMENT_CREATED,
            timestamp: now,
            rawData: { subscription_id: subscription.id },
            isRecurring: true,
          });
          return created;
        });
      } catch (e) {
        if (!isIntegrityError(e)) throw e;
        // A concurrent run already created the renewal payment for this period (uq_payment_idempotency_key). Skip: the
        // other run owns the charge.
        logger.warn(`Concurrent renewal create for subscription ${subscription.id} (key ${renewalKey}); skipping`);
        results.skipped += 1;
        continue;
      }
      paymentId = payment.id;
      const chargedPaymentId = payment.id;

      // NO TRANSACTION: the external API call (2-5 seconds)
      const request = buildPaymentRequest(products, payment, {
        descriptionPrefix: 'Auto-renewal: ',
        paymentMethodId:
          subscription.paymentMethodId || (subscription.recurringDetails.payment_method_id as string | undefined),
      });
      const response = await yookassaPayments.create(request, renewalKey);
      logger.info(`YooKassa response for payment ${paymentId}: status=${response.status}, id=${response.id}`);
      const succeeded = response.status === 'succeeded';

      // Transaction 2b: save the result and advance the dunning state. Returns what to report after the commit.
      const analytics = await ctx.withTransaction(async (services): Promise<[string, Json] | null> => {
        let toReport: [string, Json] | null = null;
        await services.repos.payments.update(chargedPaymentId, {
          status: succeeded ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
          providerPaymentId: response.id,
          providerMetadata: response.metadata ?? {},
          isRecurring: true,
        });
        await services.repos.paymentEvents.create({
          paymentId: chargedPaymentId,
          providerId: subscription.providerId,
          eventType: succeeded ? PaymentEventType.PAYMENT_SUCCEEDED : PaymentEventType.PAYMENT_FAILED,
          timestamp: now,
          rawData: { subscription_id: subscription.id },
          isRecurring: true,
        });

        if (succeeded) {
          // Reward (extends the end date and sets ACTIVE via the top-up), then reset the dunning state.
          const paymentRow = await services.repos.payments.getById(chargedPaymentId);
          if (paymentRow && !paymentRow.wasRewarded) {
            await product.reward(paymentRow.userId, paymentRow, {}, services.subscriptions);
            await services.repos.payments.update(chargedPaymentId, { wasRewarded: true });
            // Reported by whichever path rewards: a webhook that got here first has already captured it.
            toReport = ['payment_succeeded', {}];
          }
          await services.repos.subscriptions.update(subscription.id, {
            status: SubscriptionStatus.ACTIVE,
            failedRenewalCount: 0,
            lastRenewalAttemptAt: now,
          });
          results.success += 1;
          if (wasPastDue) {
            results.recovered += 1;
            dunningEvents.push({ userId: subscription.userId, kind: 'recovered' });
          }
          logger.info(`Successfully charged subscription ${subscription.id}`);
          return toReport;
        }

        // Decline: advance the dunning state machine.
        const reason = response.cancellation_details?.reason ?? null;
        const revoked = reason === 'permission_revoked';
        const newCount = (subscription.failedRenewalCount || 0) + 1;
        const exhausted = newCount >= MAX_RENEWAL_ATTEMPTS;
        let status: SubscriptionStatus;
        if (revoked || exhausted) {
          status = SubscriptionStatus.EXPIRED;
          results.dunning_expired += 1;
          dunningEvents.push({
            userId: subscription.userId,
            kind: 'expired',
            count: newCount,
            reason: revoked ? 'card revoked' : 'retries exhausted',
          });
        } else {
          status = SubscriptionStatus.PAST_DUE;
          results.past_due += 1;
          dunningEvents.push({ userId: subscription.userId, kind: 'past_due', count: newCount });
        }
        await services.repos.subscriptions.update(subscription.id, {
          status,
          failedRenewalCount: newCount,
          lastRenewalAttemptAt: now,
        });
        results.failed += 1;
        logger.info(
          `Renewal declined for subscription ${subscription.id}: -> ${status} (attempt ${newCount}/${MAX_RENEWAL_ATTEMPTS}, reason=${reason})`,
        );
        return ['payment_failed', { provider_id: subscription.providerId, reason, attempt: newCount }];
      });

      // Same event and props as the webhook path (PaymentsService), so revenue insights see renewals; is_recurring is
      // what marks them. Only after the commit, so a rolled-back result is never reported.
      if (analytics) {
        const [event, extra] = analytics;
        posthog.capture(subscription.userId, event, {
          user_id: subscription.userId,
          product_id: subscription.productId,
          amount,
          currency: subscription.currency,
          is_recurring: true,
          payment_id: paymentId,
          ...extra,
        });
      }
    } catch (err) {
      logger.error({ err }, `Failed to charge subscription ${subscription.id}: ${errorMessage(err)}`);
      results.failed += 1;

      // A transport failure may mean the card WAS charged (a timeout after the charge). Do NOT advance the dunning
      // counter or downgrade the sub on a bare exception: only mark the payment FAILED and stamp the attempt time, so
      // retry spacing applies and the next run re-attempts idempotently.
      const failedPaymentId = paymentId;
      try {
        await ctx.withTransaction(async (services) => {
          if (failedPaymentId) {
            await services.repos.payments.update(failedPaymentId, {
              status: PaymentStatus.FAILED,
              providerMetadata: { error: errorMessage(err) },
            });
          }
          await services.repos.subscriptions.update(subscription.id, { lastRenewalAttemptAt: now });
        });
      } catch (updateError) {
        logger.error(
          `Failed to record renewal error for subscription ${subscription.id}: ${errorMessage(updateError)}`,
        );
      }
    }
  }

  // Telegram Stars subscriptions: monitoring only
  if (telegramStarsSubs.length > 0) {
    try {
      await ctx.withTransaction(async (services) => {
        // Only a live native monthly sub renews at Telegram; weekly and yearly Stars are one-time purchases that simply
        // end (the same check cancel makes).
        const renewing: string[] = [];
        const ending: string[] = [];
        for (const sub of telegramStarsSubs) {
          const user = await requireUser(services, sub.userId);
          (isNativeStarsSubscription(sub, products) ? renewing : ending).push(userRef(user));
        }
        const parts = [`⭐ <b>${telegramStarsSubs.length} Stars subscriptions expiring</b>`];
        if (renewing.length > 0) parts.push(`Telegram renews these itself:\n${bulletList(renewing)}`);
        if (ending.length > 0) parts.push(`One-time, these end:\n${bulletList(ending)}`);
        await services.messages.queueAdminBroadcast(`${parts.join('\n')}\n${tags('stars')}`, { silent: true });
        results.skipped += telegramStarsSubs.length;
      });
    } catch (e) {
      logger.error(`Failed to send Telegram Stars notification: ${errorMessage(e)}`);
    }
  }

  // Summary
  if (manuallyChargedSubs.length > 0) {
    try {
      await ctx.withTransaction(async (services) => {
        const refs: string[] = [];
        for (const sub of manuallyChargedSubs) refs.push(userRef(await requireUser(services, sub.userId)));
        await services.messages.queueAdminBroadcast(
          `🔧 <b>Charging ${manuallyChargedSubs.length} expiring subscriptions</b>\n${bulletList(refs)}\n${tags('charging')}`,
          { silent: true },
        );
      });
    } catch (e) {
      logger.error(`Failed to send admin notification: ${errorMessage(e)}`);
    }
  }

  // Dunning summary: PAST_DUE entered / dunning-EXPIRED / recovered, the revenue-at-risk signals.
  if (dunningEvents.length > 0) {
    try {
      await ctx.withTransaction(async (services) => {
        const lines: string[] = [];
        const userTags: string[] = [];
        for (const event of dunningEvents) {
          const user = await services.users.getUserById(event.userId);
          const handle = user ? userRef(user) : `<code>${event.userId}</code>`;
          if (user) userTags.push(userTag(user));
          if (event.kind === 'past_due') {
            lines.push(`⚠️ Past due ${handle} — attempt ${event.count}/${MAX_RENEWAL_ATTEMPTS}`);
          } else if (event.kind === 'expired') {
            lines.push(`🚫 Lost ${handle} — ${esc(event.reason)} after ${event.count} attempts`);
          } else {
            lines.push(`✅ Recovered ${handle} — renewal went through after past due`);
          }
        }
        await services.messages.queueAdminBroadcast(
          `💳 <b>Dunning</b>\n${lines.join('\n')}\n${tags('dunning', ...userTags)}`,
        );
      });
    } catch (e) {
      logger.error(`Failed to send dunning notification: ${errorMessage(e)}`);
    }
  }

  logger.info(
    `Job completed: charge_expiring_subscriptions - Success: ${results.success}, Failed: ${results.failed}, Skipped: ${results.skipped}, PastDue: ${results.past_due}, DunningExpired: ${results.dunning_expired}, Recovered: ${results.recovered}`,
  );
  return results;
}

/**
 * Expire outdated subscriptions, one transaction each.
 *
 * Expires ACTIVE subs past their end date, plus PAST_DUE subs whose dunning grace window has fully elapsed: the safety
 * net that guarantees a stuck PAST_DUE row cannot grant free access forever if the renewal job stops selecting it.
 */
export async function expireOutdatedSubscriptionsJob(
  ctx: SubscriptionJobContext,
  products: ProductCatalog = appProducts,
): Promise<{ expired: number; total?: number }> {
  logger.info('Job started: expire_outdated_subscriptions');
  const now = new Date();

  const expiringSubs = await ctx.withTransaction((services) =>
    services.repos.subscriptions.getExpirableSubscriptions(now, new Date(now.getTime() - GRACE_PERIOD_MS)),
  );

  if (expiringSubs.length === 0) {
    logger.info('No outdated subscriptions found');
    return { expired: 0 };
  }

  logger.info(`Found ${expiringSubs.length} subscriptions to expire`);
  let expiredCount = 0;
  const adminMessages: string[] = [];

  for (const subscription of expiringSubs) {
    try {
      logger.info(`Expiring subscription ${subscription.id} for user ${subscription.userId}`);

      await ctx.withTransaction(async (services) => {
        await services.repos.subscriptions.update(subscription.id, {
          status: SubscriptionStatus.EXPIRED,
          canceledAt: now,
        });

        const user = await requireUser(services, subscription.userId);
        const productName = products.getProduct(subscription.productId)?.name ?? subscription.productId;
        const durationDays = daysBetween(subscription.startDate, subscription.endDate);

        // Dunning grace-expiry is flagged distinctly from natural expiry
        const graceNote = subscription.status === SubscriptionStatus.PAST_DUE ? ' · past-due grace elapsed' : '';
        adminMessages.push(`${userRef(user)} — ${esc(productName)}, ${durationDays}d${graceNote}`);

        expiredCount += 1;
      });

      logger.info(`Successfully expired subscription ${subscription.id}`);
    } catch (err) {
      logger.error({ err }, `Failed to expire subscription ${subscription.id}: ${errorMessage(err)}`);
    }
  }

  if (adminMessages.length > 0) {
    try {
      await ctx.withTransaction((services) =>
        services.messages.queueAdminBroadcast(
          `⌛ <b>${expiredCount} subscriptions expired</b>\n${bulletList(adminMessages)}\n${tags('expired')}`,
          { silent: true },
        ),
      );
    } catch (e) {
      logger.error(`Failed to send admin notification: ${errorMessage(e)}`);
    }
  }

  logger.info(`Job completed: expire_outdated_subscriptions - Expired: ${expiredCount}/${expiringSubs.length}`);
  return { expired: expiredCount, total: expiringSubs.length };
}

/** For the worker's job map, under Python's job names. */
export const jobs = {
  charge_expiring_subscriptions_job: (ctx: SubscriptionJobContext) => chargeExpiringSubscriptionsJob(ctx),
  expire_outdated_subscriptions_job: (ctx: SubscriptionJobContext) => expireOutdatedSubscriptionsJob(ctx),
};
