import { randomUUID } from 'node:crypto';
import type { Bot } from 'grammy';
import { posthog } from '../../clients/posthog';
import type { RabbitProducer } from '../../clients/rabbit';
import { settings } from '../../config';
import {
  isFinalPaymentStatus,
  type Payment,
  PaymentEventType,
  PaymentProvider,
  PaymentStatus,
  type Subscription,
  SubscriptionStatus,
} from '../../db/schema';
import { BaseService } from '../../lib/base-service';
import { RefundNotAllowedException } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import { esc, fmtMoney, tags, userRef, userTag } from '../messages/admin-messages';
import type { UserSchema } from '../users/schemas';
import { type PaymentProduct, type ProductCatalog, productDailyPurchaseLimit, productTakeBack } from './products';
import { getProvider } from './providers';
import { isNativeStarsSubscription } from './providers/telegram-stars';
import type { ProductListing, ProductPriceSchema } from './schemas';
import {
  type Json,
  type PaymentProviderInterface,
  type PaymentReturnData,
  type PaymentUpdate,
  PaymentValueError,
  ProviderRefundError,
  PurchaseLimitError,
  type RecurringDetails,
} from './types';
import { addDays, errorMessage, isoformat } from './utils';

export { ProviderRefundError, PurchaseLimitError } from './types';

const logger = getLogger('payments');

const REPORT_DEFAULT_NOTE = 'Nothing was taken back: revoke the access or readings by hand if needed.';

/**
 * `providerId -> provider`, each built on first lookup: `services.payments` is built once per request, and most
 * requests (listing products, status checks) never reach a provider.
 */
class LazyProviders {
  readonly #ids: ReadonlySet<string>;
  readonly #built = new Map<string, PaymentProviderInterface>();

  constructor(
    providerIds: PaymentProvider[],
    private readonly repos: Repos,
    private readonly services: Services,
    private readonly products: ProductCatalog,
  ) {
    this.#ids = new Set(providerIds);
  }

  /** `null` for an id that isn't configured. */
  get(providerId: string): PaymentProviderInterface | null {
    if (!this.#ids.has(providerId)) return null;
    let provider = this.#built.get(providerId);
    if (!provider) {
      provider = getProvider(providerId, this.repos, this.services, this.products);
      this.#built.set(providerId, provider);
    }
    return provider;
  }

  has(providerId: string): boolean {
    return this.#ids.has(providerId);
  }

  keys(): string[] {
    return [...this.#ids];
  }
}

/** `bank_card` / `sbp` / ... from YooKassa; `telegram_stars` for Stars. */
export function paymentMethodType(
  payment: Pick<Payment, 'providerId'>,
  details: RecurringDetails | null,
): string | null {
  if (payment.providerId === PaymentProvider.TELEGRAM_STARS) return 'telegram_stars';
  return (details?.payment_method_type as string | undefined) ?? null;
}

/**
 * `payment_failed` for a payment that ended FAILED or CANCELED, with the provider's reason when it gives one. Sent
 * once: from the webhook or from the status poll, whichever sees the final status first (the other finds the row
 * already final).
 */
function captureFailure(payment: Payment, status: PaymentStatus | undefined, details: RecurringDetails | null): void {
  posthog.capture(payment.userId, 'payment_failed', {
    user_id: payment.userId,
    product_id: payment.productId,
    amount: payment.amount,
    currency: payment.currency,
    provider_id: payment.providerId,
    is_recurring: payment.isRecurring,
    payment_id: payment.id,
    status: status ?? null,
    payment_method_type: paymentMethodType(payment, details),
    // Same names as the renewal job's payment_failed.
    reason: details?.cancellation_reason ?? null,
    party: details?.cancellation_party ?? null,
  });
}

export class PaymentsService extends BaseService {
  /** Built on first use. Add more providers here as needed. */
  readonly providers: LazyProviders;

  constructor(
    repos: Repos,
    producer: RabbitProducer,
    services: Services,
    bot: Bot | null,
    readonly products: ProductCatalog,
  ) {
    super(repos, producer, services, bot);
    this.providers = new LazyProviders(
      [PaymentProvider.YOOKASSA, PaymentProvider.TELEGRAM_STARS],
      repos,
      services,
      products,
    );
  }

  /** Reward the user for a successful payment; `updateData` records it on the row. */
  private async handleSuccess(
    payment: Payment,
    recurringDetails: RecurringDetails,
    updateData: PaymentUpdate,
  ): Promise<void> {
    const product = this.products.getProduct(payment.productId);
    if (!product || payment.wasRewarded) return;

    await product.reward(payment.userId, payment, recurringDetails, this.services.subscriptions);

    posthog.capture(payment.userId, 'payment_succeeded', {
      user_id: payment.userId,
      product_id: payment.productId,
      amount: payment.amount,
      currency: payment.currency,
      is_recurring: payment.isRecurring,
      payment_id: payment.id,
      provider_id: payment.providerId,
      payment_method_type: paymentMethodType(payment, recurringDetails),
    });

    updateData.wasRewarded = true;
  }

  /**
   * Report a refunded payment. What was taken back is in `accessNote`; without one, nothing was (a YooKassa dashboard
   * refund: whoever refunds decides about access and credits).
   */
  private async handleRefund(
    payment: Payment,
    accessNote: string | null = null,
    knownUser: UserSchema | null = null,
  ): Promise<void> {
    posthog.capture(payment.userId, 'payment_refunded', {
      user_id: payment.userId,
      product_id: payment.productId,
      amount: payment.amount,
      currency: payment.currency,
      payment_id: payment.id,
    });
    const user = knownUser ?? (await this.services.users.getUserById(payment.userId));
    const who = user ? userRef(user) : `<code>${payment.userId}</code>`;
    await this.services.messages.queueAdminBroadcast(
      `↩️ <b>Refund</b> · ${who} — ${fmtMoney(payment.amount, payment.currency)} for ${esc(payment.productId)}\n` +
        `<i>Payment marked REFUNDED. ${accessNote ? esc(accessNote) : REPORT_DEFAULT_NOTE}</i>\n` +
        tags('refund', ...(user ? [userTag(user)] : [])),
    );
  }

  /**
   * Refund a succeeded payment at its provider (an admin action) and take back what it paid for.
   *
   * The subscription loses the payment's period (the end date moves back by the product's duration; with nothing left
   * it ends now), and a provider-managed subscription is canceled so it doesn't charge again. Throws
   * `RefundNotAllowedException` when the payment can't be refunded here (not SUCCEEDED, or a provider without a refund
   * API: YooKassa refunds are made in its dashboard).
   *
   * The DB work (writes and the reads the report needs) comes first and the provider call last: if the provider
   * refuses (`ProviderRefundError`), the transaction rolls back and nothing changed. After the money is back, nothing
   * may fail the request. If the provider did refund but the call still failed (a timeout), its refund notice finishes
   * the job: see `processCallback`.
   */
  async refundPayment(paymentId: string): Promise<Payment> {
    const payment = await this.repos.payments.getByIdWithLock(paymentId);
    if (payment === null) throw new RefundNotAllowedException('Payment not found');
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new RefundNotAllowedException(`Only a succeeded payment can be refunded (this one is ${payment.status})`);
    }
    const provider = this.providers.get(payment.providerId);
    if (!provider?.supportsRefund) {
      throw new RefundNotAllowedException(`${payment.providerId} payments can't be refunded from here`);
    }

    const now = new Date();
    const refunded = await this.repos.payments.update(payment.id, {
      status: PaymentStatus.REFUNDED,
      providerMetadata: { ...payment.providerMetadata, refunded_at: isoformat(now) },
    });
    await this.repos.paymentEvents.create({
      paymentId: payment.id,
      providerId: payment.providerId,
      eventType: PaymentEventType.PAYMENT_REFUNDED,
      timestamp: now,
      rawData: { source: 'admin_refund' },
    });
    const { subscription, note } = await this.takeBackPeriod(payment, now);
    const user = await this.services.users.getUserById(payment.userId); // for the report, before the point of no return

    try {
      await provider.refund(payment);
    } catch (e) {
      throw new ProviderRefundError(errorMessage(e), { cause: e });
    }

    const accessNote = await this.stopRenewalsAfterRefund(payment, subscription, note);
    try {
      await this.handleRefund(payment, accessNote, user);
    } catch (err) {
      // The money is back: a reporting failure must not roll the REFUNDED row back.
      logger.error({ err }, `Refund ${payment.id}: reporting failed: ${errorMessage(err)}`);
    }
    return refunded ?? payment;
  }

  /**
   * Cancel the refunded subscription at its provider. The money is back already, so a failure is only noted: it risks
   * a future renewal, which the resurrection guard in `topUpSubscription` refuses for a canceled sub.
   */
  private async stopRenewalsAfterRefund(
    payment: Payment,
    subscription: Subscription | null,
    accessNote: string,
  ): Promise<string> {
    if (subscription === null) return accessNote;
    try {
      await this.cancelProviderSubscription(subscription);
    } catch (e) {
      logger.error(
        `Refund ${payment.id}: canceling subscription ${subscription.id} at the provider failed: ${errorMessage(e)}`,
      );
      return `${accessNote} Cancel at ${subscription.providerId} failed: ${errorMessage(e)}`;
    }
    return accessNote;
  }

  /**
   * Take back what the refunded payment gave: the product's own take-back (e.g. a credit pack's unspent credits), else
   * the period from its subscription.
   */
  private async takeBackPeriod(
    payment: Payment,
    now: Date,
  ): Promise<{ subscription: Subscription | null; note: string }> {
    const product = this.products.getProduct(payment.productId);
    const note = await productTakeBack(product, payment, this.services.subscriptions);
    if (note !== null) return { subscription: null, note };
    const noSubscription = { subscription: null, note: 'No subscription was linked to this payment.' };
    if (!payment.subscriptionId) return noSubscription;
    const subscription = await this.repos.subscriptions.getByIdWithLock(payment.subscriptionId);
    if (subscription === null) return noSubscription;

    const days = product ? product.durationDays : 0;
    const endDate = addDays(subscription.endDate, -days);
    const canceled = { canceledAt: subscription.canceledAt ?? now, cancellationReason: 'refunded' };
    if (endDate.getTime() <= now.getTime()) {
      const updated = await this.repos.subscriptions.update(subscription.id, {
        status: SubscriptionStatus.EXPIRED,
        endDate: now,
        ...canceled,
      });
      return { subscription: updated ?? subscription, note: 'Access ended now.' };
    }
    const updated = await this.repos.subscriptions.update(subscription.id, {
      status: SubscriptionStatus.CANCELED,
      endDate,
      ...canceled,
    });
    return {
      subscription: updated ?? subscription,
      note: `Access shortened by ${days} days, to ${endDate.toISOString().slice(0, 10)}; renewals stopped.`,
    };
  }

  /**
   * Start a payment. `locale` is the app's i18n locale ('ru'/'en') for the provider's UI. Returns the provider's data
   * for the client: what to confirm the payment with.
   */
  async startPayment(
    userId: string,
    productId: string,
    currency: string,
    providerId: string,
    returnUrl: string | null = null,
    locale: string | null = null,
  ): Promise<PaymentReturnData> {
    logger.info(
      `Starting payment for user ${userId} product ${productId} currency ${currency} provider ${providerId} return url ${returnUrl}`,
    );

    // Only what's on sale (plus test products in debug mode): a legacy plan keeps renewing, refunding and canceling by
    // its own product, but can't be bought again from an old link.
    const onSale = {
      ...this.products.AVAILABLE_PRODUCTS,
      ...(settings.debug ? this.products.TEST_PRODUCTS : {}),
    };
    const product = Object.hasOwn(onSale, productId) ? onSale[productId] : undefined;
    if (!product) throw new PaymentValueError(`Product ${productId} not found or not available`);
    // The Stars invoice charges `amount` Stars whatever the currency, so the client must not pick one: with USD a
    // monthly plan would cost 3 Stars. Python takes any currency here.
    if (providerId === PaymentProvider.TELEGRAM_STARS && currency !== 'XTR') {
      throw new PaymentValueError(`Telegram Stars payments are in XTR, not ${currency}`);
    }
    await this.checkDailyPurchaseLimit(userId, product);

    const { amount } = product.getPriceFor(currency);
    const payment = await this.repos.payments.create({
      userId,
      productId,
      providerId: providerId as PaymentProvider,
      amount,
      currency,
      status: PaymentStatus.CREATED,
      // Persisted before the provider call so a retry reuses the same key (no double-charge).
      idempotencyKey: randomUUID().replaceAll('-', ''),
      providerPaymentId: null,
      providerMetadata: {},
    });
    logger.info(`Payment record created with id: ${payment.id}`);

    posthog.capture(userId, 'payment_record_created', {
      user_id: userId,
      product_id: productId,
      currency,
      amount,
      provider_id: providerId,
      payment_id: payment.id,
    });

    await this.repos.paymentEvents.create({
      paymentId: payment.id,
      providerId: payment.providerId,
      eventType: PaymentEventType.PAYMENT_CREATED,
      timestamp: new Date(),
      rawData: {
        user_id: userId,
        provider_id: providerId,
        product_id: productId,
        currency,
        amount,
        return_url: returnUrl,
      },
    });

    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not supported`);
    const { paymentUpdates, returnData } = await provider.createPayment(payment, returnUrl, locale);
    logger.info(`Payment initiated with provider id: ${returnData.payment_id}`);

    posthog.capture(userId, 'payment_provider_created', {
      user_id: userId,
      product_id: productId,
      provider_id: providerId,
      return_data: returnData,
    });

    await this.repos.payments.update(payment.id, paymentUpdates);
    await this.repos.paymentEvents.create({
      paymentId: payment.id,
      providerId: payment.providerId,
      eventType: PaymentEventType.PAYMENT_INITIATED,
      timestamp: new Date(),
      rawData: { user_id: userId, provider_id: providerId, product_id: productId, return_data: returnData },
    });

    return returnData;
  }

  /**
   * Throws `PurchaseLimitError` if this purchase would go over the daily cap. Checked when the payment starts and again
   * right before Telegram charges (pre-checkout), so invoices opened ahead and paid later can't get past it.
   */
  async checkPurchaseAllowed(userId: string, productId: string): Promise<void> {
    const product = this.products.getProduct(productId);
    if (product !== null) await this.checkDailyPurchaseLimit(userId, product);
  }

  /**
   * Products with a `dailyPurchaseLimit` share it: at most that many succeeded purchases of any of them per user in
   * 24 h. A guardrail against buying compulsively (one-off packs).
   */
  private async checkDailyPurchaseLimit(userId: string, product: PaymentProduct): Promise<void> {
    const limit = productDailyPurchaseLimit(product);
    if (!limit) return;
    const limitedIds = Object.entries(this.products.AVAILABLE_PRODUCTS)
      .filter(([, available]) => productDailyPurchaseLimit(available))
      .map(([id]) => id);
    const since = new Date(Date.now() - 24 * 3_600_000);
    const bought = await this.repos.payments.countSucceededSince(userId, limitedIds, since);
    if (bought >= limit) {
      posthog.capture(userId, 'purchase_daily_limit_reached', {
        user_id: userId,
        product_id: product.productId,
        limit,
      });
      throw new PurchaseLimitError(`Daily purchase limit reached (${limit} in 24 h)`);
    }
  }

  /** Process a callback from a payment provider. */
  async processCallback(payload: Json, providerId: PaymentProvider): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      logger.error(`Received callback for unknown provider: ${providerId}`);
      return;
    }

    const { updateData, eventType, payment, recurringDetails } = await provider.processCallback(payload);

    if (!payment || !eventType) {
      logger.error('Provider callback processing failed, missing critical data');
      return;
    }

    logger.info(`Processing callback for payment ${payment.id} with event ${eventType}`);

    // Re-fetch with a pessimistic lock: check the CURRENT state, so a concurrent webhook can't overwrite a final state
    const locked = await this.repos.payments.getByIdWithLock(payment.id);
    if (locked === null) throw new Error(`Payment ${payment.id} disappeared while processing its callback`);

    const recordEvent = () =>
      this.repos.paymentEvents.create({
        paymentId: payment.id,
        providerId,
        eventType,
        timestamp: new Date(),
        rawData: payload,
      });

    // State machine protection: the one exit from a final state is a refund of a succeeded payment.
    const isRefund = eventType === PaymentEventType.PAYMENT_REFUNDED && locked.status === PaymentStatus.SUCCEEDED;
    // Only a SUCCEEDED payment can be refunded: a refund for anything else (already refunded, or a row whose
    // successful_payment never arrived) is logged and changes nothing.
    const notRefundable = eventType === PaymentEventType.PAYMENT_REFUNDED && !isRefund;
    if ((isFinalPaymentStatus(locked.status) && !isRefund) || notRefundable) {
      logger.warn(
        `Ignoring ${eventType} for payment ${payment.id} in state ${locked.status}. Attempted transition from provider: ${updateData.status ?? 'unknown'}`,
      );
      await recordEvent(); // still logged, for monitoring and debugging
      return;
    }

    // The payment is not final and is locked: safe to update
    if (eventType === PaymentEventType.PAYMENT_SUCCEEDED) {
      await this.handleSuccess(locked, recurringDetails ?? {}, updateData);
    } else if (isRefund) {
      let accessNote: string | null = null;
      if (provider.supportsRefund) {
        // A refund through the provider's API (Telegram Stars) we haven't recorded: our own refundPayment whose request
        // failed after the provider had refunded (a timeout), or one the provider made itself. The money is back
        // either way, so take back what the payment gave, as refundPayment does.
        const { subscription, note } = await this.takeBackPeriod(locked, new Date());
        accessNote = await this.stopRenewalsAfterRefund(locked, subscription, note);
      }
      await this.handleRefund(locked, accessNote);
    } else if (eventType === PaymentEventType.PAYMENT_FAILED || eventType === PaymentEventType.PAYMENT_CANCELED) {
      captureFailure(locked, updateData.status, recurringDetails);
    }

    await this.repos.payments.update(payment.id, updateData);
    await recordEvent();
  }

  /**
   * Tell the payment provider to stop future renewals.
   *
   * Routes to the provider that owns the subscription. For Telegram Stars this calls editUserStarSubscription so
   * Telegram stops auto-debiting; for YooKassa it is a no-op (our own dunning job drives those renewals, so CANCELED
   * already stops them). A native Star subscription still live on the row is canceled at Telegram even when a later
   * purchase (e.g. a plan by card) made the row another provider's. Best-effort by contract: callers should not let a
   * provider-side failure block the user's cancel; the `topUpSubscription` resurrection guard is the safety net.
   */
  async cancelProviderSubscription(subscription: Subscription): Promise<void> {
    const providerIds: string[] = [subscription.providerId];
    if (
      subscription.providerId !== PaymentProvider.TELEGRAM_STARS &&
      isNativeStarsSubscription(subscription, this.products)
    ) {
      providerIds.push(PaymentProvider.TELEGRAM_STARS);
    }
    for (const providerId of providerIds) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        logger.warn(`No provider for subscription ${subscription.id} (${providerId}); cannot cancel remotely`);
        continue;
      }
      await provider.cancel(subscription);
    }
  }

  /**
   * The payment if the user owns it, reconciling live status when non-final. `null` when not found or not owned (the
   * route's 404).
   */
  async getPaymentStatus(userId: string, paymentId: string): Promise<Payment | null> {
    const payment = await this.repos.payments.getById(paymentId);
    if (!payment || payment.userId !== userId) return null;
    if (isFinalPaymentStatus(payment.status)) return payment;
    const provider = this.providers.get(payment.providerId);
    if (!provider) return payment;
    const { status: liveStatus, recurringDetails } = await provider.getPaymentStatus(payment);
    if (liveStatus === payment.status) return payment;
    // Re-fetch under lock so a webhook-set final state is never clobbered (same guard as processCallback).
    const locked = await this.repos.payments.getByIdWithLock(payment.id);
    if (locked === null) return payment;
    if (isFinalPaymentStatus(locked.status)) return locked;
    const updateData: PaymentUpdate = { status: liveStatus };
    if (liveStatus === PaymentStatus.FAILED || liveStatus === PaymentStatus.CANCELED) {
      captureFailure(locked, liveStatus, recurringDetails);
    }
    if (liveStatus === PaymentStatus.SUCCEEDED) {
      // Grant entitlement here too: otherwise the reconcile leaves a SUCCEEDED-but-unrewarded row, and the webhook's
      // finality guard would then refuse to reward it (the user pays but never gets the subscription). Idempotent via
      // wasRewarded and the row lock above, so the webhook and the poll can't double-grant: whichever finalizes first
      // grants, the other no-ops. The reconcile already did the authoritative findOne, so granting here is as secure
      // as the webhook.
      await this.handleSuccess(locked, recurringDetails, updateData);
      await this.repos.paymentEvents.create({
        paymentId: locked.id,
        providerId: locked.providerId,
        eventType: PaymentEventType.PAYMENT_SUCCEEDED,
        timestamp: new Date(),
        rawData: { source: 'status_reconcile', remote_status: liveStatus },
      });
    }
    const updated = await this.repos.payments.update(payment.id, updateData);
    return updated ?? locked;
  }

  /**
   * All currencies a product can be bought in. The contract doesn't require `prices`, so fall back to the single
   * requested-currency price. Lets the frontend surface the Telegram Stars (XTR) amount without a second round-trip.
   */
  private currencyPrices(product: PaymentProduct, fallbackCurrency: string): ProductPriceSchema[] {
    const prices = Object.values(product.prices ?? {});
    if (prices.length > 0) return prices.map(({ currency, amount }) => ({ currency, amount }));
    const { currency, amount } = product.getPriceFor(fallbackCurrency);
    return [{ currency, amount }];
  }

  private toListing(product: PaymentProduct, currency: string): ProductListing {
    const price = product.getPriceFor(currency);
    return {
      id: product.productId,
      name: product.name,
      price: price.amount,
      currency: price.currency,
      durationDays: product.durationDays,
      recurring: product.recurring,
      prices: this.currencyPrices(product, currency),
    };
  }

  /** Products on sale, and test products in debug mode. */
  getAvailableProducts(currency = 'RUB'): ProductListing[] {
    const products = {
      ...this.products.AVAILABLE_PRODUCTS,
      ...(settings.debug ? this.products.TEST_PRODUCTS : {}),
    };
    return Object.values(products).map((product) => this.toListing(product, currency));
  }

  /** `userId` is unused, kept for API compatibility. */
  async getAvailableProductsAsync(_userId: string | null = null, currency = 'RUB'): Promise<ProductListing[]> {
    return this.getAvailableProducts(currency);
  }

  /** Products for the profile page: no test products. `userId` is unused, kept for API compatibility. */
  async getProfileProductsAsync(_userId: string | null = null, currency = 'RUB'): Promise<ProductListing[]> {
    return Object.values(this.products.CURRENT_OFFERS).map((product) => this.toListing(product, currency));
  }
}
