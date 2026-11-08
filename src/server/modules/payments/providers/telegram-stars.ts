import { Bot } from 'grammy';
import { getSharedBot } from '../../../clients/bot';
import { type Payment, PaymentEventType, PaymentProvider, PaymentStatus, type Subscription } from '../../../db/schema';
import { getLogger } from '../../../lib/logging';
import type { Repos } from '../../../repos';
import type { Services } from '../../../services';
import { esc, tags } from '../../messages/admin-messages';
import { type ProductCatalog, productInvoiceText } from '../products';
import {
  type CreatedPayment,
  type Json,
  PaymentProviderInterface,
  type PaymentUpdate,
  type ProviderCallback,
  type RecurringDetails,
} from '../types';
import { errorMessage, isoformat, parseUuid } from '../utils';

const logger = getLogger('telegram-stars');

/** Native Star subscriptions renew every 30 days: Telegram's constraint. */
const NATIVE_PERIOD_SECONDS = 2_592_000;

const NOTHING: ProviderCallback = { updateData: {}, eventType: null, payment: null, recurringDetails: {} };

/**
 * Whether Telegram still renews this subscription row itself (a native monthly Star subscription not yet canceled at
 * Telegram).
 *
 * Read from the row's own record, not from its current product or provider: another purchase merged into the row (the
 * weekly plan in Stars, any plan by card) replaces productId and providerId, while the native subscription keeps
 * renewing at Telegram. The initial native charge stores `telegram_subscription_charge_id`; a cancel at Telegram sets
 * `telegram_subscription_canceled`. Monthly Stars subs from before the first-charge id was stored count as native too.
 */
export function isNativeStarsSubscription(
  subscription: Pick<Subscription, 'recurringDetails' | 'productId' | 'providerId'>,
  products: ProductCatalog,
): boolean {
  const details = subscription.recurringDetails ?? {};
  if (details.telegram_subscription_canceled) return false;
  if (details.telegram_subscription_charge_id) return true;
  const product = products.getProduct(subscription.productId);
  return Boolean(
    subscription.providerId === PaymentProvider.TELEGRAM_STARS &&
      product?.recurring &&
      product.durationDays === 30 &&
      (details.telegram_subscription_managed ?? true),
  );
}

export class TelegramStarsProvider extends PaymentProviderInterface {
  override readonly supportsRefund = true;
  #bot?: Bot;

  constructor(
    private readonly repos: Repos,
    private readonly services: Services,
    private readonly products: ProductCatalog,
  ) {
    super();
  }

  /**
   * The process bot the services carry, else the process-wide fallback. Never a new `Bot` per provider: providers are
   * built per request. Only a real grammY `Bot` is reused, not an app's null bot, which would turn a failed invoice
   * into a silent nothing. Its defaults can't change what we send: createInvoiceLink, refundStarPayment and
   * editUserStarSubscription have no parse mode to fill in.
   */
  get bot(): Bot {
    if (this.#bot) return this.#bot;
    const { bot } = this.services;
    return bot instanceof Bot ? bot : getSharedBot();
  }

  set bot(bot: Bot) {
    this.#bot = bot;
  }

  async createPayment(payment: Payment, _returnUrl?: string | null, locale?: string | null): Promise<CreatedPayment> {
    try {
      const starsAmount = Math.trunc(payment.amount);
      const product = this.products.getProduct(payment.productId);

      // Native Telegram Star subscriptions are 30-day-only, so only the monthly plan can auto-renew via Stars; any
      // other recurring plan (e.g. yearly) is sold as a ONE-TIME Star payment with self-managed expiry.
      const isNativeSub = Boolean(product?.recurring && product.durationDays === 30);

      let title = product ? product.name : `Product ${payment.productId}`;
      let description = `Purchase of ${title}`;
      if (isNativeSub) description += ' - Auto-renewing every 30 days';
      else if (product?.recurring) description += ` - ${product.durationDays} days access`;
      // The app can word the invoice in the user's language (Telegram shows it in the payment sheet).
      const localized = productInvoiceText(product, locale ?? null);
      if (localized) [title, description] = localized;

      // Only the 30-day plan gets the native auto-renew period. Without it this is a one-time Star charge (the yearly
      // plan, which we expire ourselves).
      if (isNativeSub) {
        logger.info(`Creating Telegram Stars subscription invoice for payment ${payment.id} with 30-day period`);
      } else {
        logger.info(`Creating one-time Telegram Stars invoice for payment ${payment.id}`);
      }

      const invoiceLink = await this.bot.api.createInvoiceLink(
        title,
        description,
        `payment_${payment.id}`,
        '', // empty provider token for Telegram Stars
        'XTR',
        [{ label: title, amount: starsAmount }],
        {
          is_flexible: false,
          need_name: false,
          need_phone_number: false,
          need_email: false,
          need_shipping_address: false,
          send_phone_number_to_provider: false,
          send_email_to_provider: false,
          ...(isNativeSub ? { subscription_period: NATIVE_PERIOD_SECONDS } : {}),
        },
      );

      logger.info(`Created Telegram Stars invoice for payment ${payment.id}: ${invoiceLink}`);

      return {
        paymentUpdates: {
          status: PaymentStatus.WAITING_FOR_ACTION,
          providerPaymentId: `tg_stars_${payment.id}`,
          providerMetadata: {
            invoice_link: invoiceLink,
            stars_amount: starsAmount,
            title,
            description,
          },
        },
        returnData: {
          payment_id: payment.id,
          confirmation_url: invoiceLink,
          status: 'pending',
          provider: 'TELEGRAM_STARS',
          amount: starsAmount,
          currency: 'XTR',
        },
      };
    } catch (e) {
      const error = errorMessage(e);
      logger.error(`Failed to create Telegram Stars payment for payment ${payment.id}: ${error}`);
      return {
        paymentUpdates: { status: PaymentStatus.FAILED, providerMetadata: { error } },
        returnData: {
          payment_id: payment.id,
          confirmation_url: '', // no invoice for a failed payment
          status: 'failed',
          provider: 'TELEGRAM_STARS',
          amount: payment.amount,
          currency: payment.currency,
          error,
        },
      };
    }
  }

  /** A callback from Telegram: a pre-checkout query, a successful payment or a refund. */
  async processCallback(payload: Json): Promise<ProviderCallback> {
    try {
      return await this.handleCallback(payload);
    } catch (e) {
      logger.error(`Error processing Telegram Stars callback: ${errorMessage(e)}`);
      return NOTHING;
    }
  }

  private async handleCallback(payload: Json): Promise<ProviderCallback> {
    // The invoice's custom payload, "payment_{uuid}", identifies the payment
    let paymentId: string | null = null;
    if ('payload' in payload) {
      const customPayload = payload.payload as string;
      if (customPayload.startsWith('payment_')) paymentId = customPayload.replaceAll('payment_', '');
    }

    if (!paymentId) {
      logger.error(`Could not extract payment ID from payload: ${JSON.stringify(payload)}`);
      return NOTHING;
    }
    if (parseUuid(paymentId) === null) throw new Error(`Malformed payment id: ${paymentId}`);

    let payment: Payment | null = null;
    const refundedPayment = (payload.refunded_payment ?? {}) as Json;
    const refundedChargeId = refundedPayment.telegram_payment_charge_id as string | undefined;
    if (refundedChargeId) {
      // A refund names the exact charge. A renewal has its own row keyed by the charge id, while the invoice payload
      // always points at the subscription's first row.
      payment = await this.repos.payments.getByProviderPaymentId(refundedChargeId);
    }
    if (!payment) {
      payment = await this.repos.payments.getById(paymentId);
      const storedChargeId = payment?.providerMetadata?.telegram_payment_charge_id;
      if (payment && refundedChargeId && storedChargeId && storedChargeId !== refundedChargeId) {
        // A charge we have no row for (a renewal whose successful_payment was lost). The payload's row is another
        // charge: marking it REFUNDED would be wrong.
        await this.alertUnknownRefund(payment, refundedChargeId);
        return NOTHING;
      }
    }
    if (!payment) {
      logger.error(`Payment ${paymentId} not found`);
      return NOTHING;
    }

    if (payload.successful_payment) return this.handleSuccessfulPayment(payload, payment, paymentId);

    if (payload.refunded_payment) {
      // Telegram refunded a Star charge (our refundStarPayment, or a refund made on Telegram's side). The service lets
      // only a SUCCEEDED payment become REFUNDED, so a refund already recorded by refundPayment is a logged no-op here.
      logger.info(`Telegram Stars refund for payment ${payment.id} (charge ${refundedChargeId})`);
      return {
        updateData: {
          status: PaymentStatus.REFUNDED,
          providerMetadata: { ...payment.providerMetadata, refunded_at: isoformat(new Date()) },
        },
        eventType: PaymentEventType.PAYMENT_REFUNDED,
        payment,
        recurringDetails: {},
      };
    }

    if (payload.pre_checkout_query) {
      // Pre-checkout query: validate and approve
      const query = payload.pre_checkout_query as Json;
      logger.info(`Telegram Stars pre-checkout query for payment ${paymentId}`);
      return {
        updateData: { providerMetadata: { ...payment.providerMetadata, pre_checkout_query_id: query.id } },
        eventType: PaymentEventType.PROVIDER_RESPONSE,
        payment,
        recurringDetails: {},
      };
    }

    logger.warn(`Unknown Telegram Stars callback type: ${JSON.stringify(payload)}`);
    return { updateData: {}, eventType: null, payment, recurringDetails: {} };
  }

  /** Payment succeeded: the initial charge or an auto-renewal. */
  private async handleSuccessfulPayment(payload: Json, payment: Payment, paymentId: string): Promise<ProviderCallback> {
    const successfulPayment = payload.successful_payment as Json;
    const chargeId = successfulPayment.telegram_payment_charge_id as string | undefined;
    const providerChargeId = successfulPayment.provider_payment_charge_id;

    // Telegram's authoritative subscription flags: is_recurring is true on EVERY subscription charge,
    // is_first_recurring only on the first one, so a renewal (auto-debit) is "recurring but not the first".
    const isRecurring = Boolean(successfulPayment.is_recurring || payload.is_recurring);
    const isFirstRecurring = Boolean(successfulPayment.is_first_recurring || payload.is_first_recurring);
    const isRenewal = isRecurring && !isFirstRecurring;

    const product = this.products.getProduct(payment.productId);
    const isSubscription = Boolean(product?.recurring);
    // Only the 30-day plan is a native Telegram-managed subscription (auto-renews, cancellable at Telegram). Any other
    // recurring plan (yearly) is a one-time Star charge we expire ourselves: nothing to cancel there.
    const isNativeSub = isSubscription && product?.durationDays === 30;

    // recurringDetails carries the Telegram charge id down to topUpSubscription so it is stored on the subscription
    // row (cancel and refunds read it later).
    let recurringDetails: RecurringDetails = {};
    if (isSubscription) {
      recurringDetails = {
        // The latest charge, overwritten each renewal by the top-up merge; used for refunds (refundStarPayment is
        // per-charge) and renewal dedup.
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: providerChargeId,
        is_renewal: isRenewal,
        // True only for the native monthly sub; the yearly one-time purchase is not Telegram-managed.
        telegram_subscription_managed: isNativeSub,
      };
      if (isNativeSub && !isRenewal) {
        // The FIRST charge id is the subscription's canonical identifier for editUserStarSubscription: Telegram wants
        // the charge id "from the first subscription payment". Set it ONCE on the initial charge under a stable key
        // the top-up merge never overwrites, so cancel sends the right id even after many renewals (the latest id
        // would be rejected and Telegram would keep debiting a "canceled" user).
        recurringDetails.telegram_subscription_charge_id = chargeId;
        // A new native subscription; an earlier one on this row may have been canceled.
        recurringDetails.telegram_subscription_canceled = false;
      }
    }

    const eventType = PaymentEventType.PAYMENT_SUCCEEDED;

    if (isRenewal) {
      // RENEWAL. Telegram auto-debited the user and re-sent the ORIGINAL invoice payload, so `payment` is the first
      // charge's row, already SUCCEEDED. Reusing it would hit the finality guard in PaymentsService.processCallback and
      // silently no-op (the sub lapses after month 1 while Telegram keeps charging). Mint a fresh, non-final row keyed
      // on this renewal's unique charge id and hand THAT to the service, so the reward extends the end date.
      // Idempotent: a redelivered renewal finds the row by charge id and lets the finality guard no-op it. The
      // get-then-create dedup isn't atomic by itself (providerPaymentId is indexed, not unique), so the first row is
      // locked first: renewals of one subscription then run one after the other, and under READ COMMITTED the second
      // sees the row the first committed. Python relies on the bot handling updates one at a time; webhook mode
      // doesn't (grammY answers a slow update with an error and Telegram redelivers it while the first run goes on).
      await this.repos.payments.getByIdWithLock(payment.id);
      const existing = chargeId ? await this.repos.payments.getByProviderPaymentId(chargeId) : null;
      if (existing) {
        logger.info(
          `Telegram Stars renewal for charge ${chargeId} already recorded (payment ${existing.id}); deferring to finality guard`,
        );
        return { updateData: {}, eventType, payment: existing, recurringDetails };
      }

      const renewalPayment = await this.repos.payments.create({
        userId: payment.userId,
        productId: payment.productId,
        providerId: payment.providerId,
        amount: payment.amount,
        currency: payment.currency,
        status: PaymentStatus.CREATED,
        isRecurring: true,
        subscriptionId: payment.subscriptionId,
        providerPaymentId: chargeId,
        providerMetadata: {
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: providerChargeId,
          is_renewal: true,
          renewed_from_payment_id: payment.id,
          payment_processed_at: isoformat(new Date()),
        },
      });
      logger.info(
        `Telegram Stars renewal recorded as fresh payment ${renewalPayment.id} (charge ${chargeId}, renewed from ${payment.id})`,
      );
      return { updateData: { status: PaymentStatus.SUCCEEDED }, eventType, payment: renewalPayment, recurringDetails };
    }

    // INITIAL charge (or a one-time purchase). The original WAITING_FOR_ACTION row is the right one to finalize; a
    // redelivery finds it already SUCCEEDED and the finality guard no-ops it.
    const updateData: PaymentUpdate = {
      status: PaymentStatus.SUCCEEDED,
      providerMetadata: {
        ...payment.providerMetadata,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: providerChargeId,
        is_renewal: false,
        payment_processed_at: isoformat(new Date()),
      },
    };
    logger.info(`Telegram Stars initial payment ${paymentId} succeeded`);
    return { updateData, eventType, payment, recurringDetails };
  }

  /**
   * Telegram manages recurring Star payments itself: nothing is charged here. The renewal arrives as a notification
   * through the bot handlers, so this only records that one is expected.
   */
  async chargeRecurring(payment: Payment, recurringDetails: RecurringDetails): Promise<ProviderCallback> {
    logger.info(
      `Telegram Stars subscription renewal expected for payment ${payment.id} - Telegram manages charging automatically`,
    );
    return {
      updateData: {
        status: PaymentStatus.WAITING_FOR_ACTION,
        providerMetadata: {
          ...payment.providerMetadata,
          renewal_expected: true,
          telegram_managed: true,
          note: 'Telegram Stars subscription renewal is managed automatically by Telegram',
          last_renewal_check: isoformat(payment.createdAt),
        },
      },
      eventType: PaymentEventType.PROVIDER_RESPONSE,
      payment,
      recurringDetails,
    };
  }

  /**
   * Give one charge's Stars back to the user (refundStarPayment). Throws on failure.
   *
   * refundStarPayment works per charge: a renewal row carries its own charge id, the first row the initial one. It
   * doesn't stop a native subscription; `PaymentsService.refundPayment` cancels that separately.
   */
  override async refund(payment: Payment): Promise<void> {
    const chargeId = payment.providerMetadata?.telegram_payment_charge_id as string | undefined;
    if (!chargeId) throw new Error(`Telegram Stars payment ${payment.id} has no stored charge id; cannot refund`);

    const user = await this.services.users.getUserById(payment.userId);
    if (!user?.telegramId) {
      throw new Error(`Telegram Stars payment ${payment.id}: user/telegram_id unavailable; cannot refund`);
    }

    await this.bot.api.refundStarPayment(user.telegramId, chargeId);
    logger.info(`Refunded Telegram Stars payment ${payment.id} (charge ${chargeId})`);
  }

  /**
   * Cancel the Telegram-managed Star subscription so Telegram stops auto-debiting.
   *
   * Telegram drives native renewals itself, so for the monthly plan a DB-only cancel is not enough: without this call
   * Telegram keeps charging and the renewal would re-activate a "canceled" sub. Telegram identifies the subscription
   * by its inception charge, so the FIRST charge id goes out; the latest renewal's id is rejected.
   *
   * One-time Star purchases (the weekly and yearly plans) are not Telegram-managed: nothing to cancel, this is a no-op
   * (the DB CANCELED is enough; the sub self-expires at the end date). Neither is a native sub already canceled at
   * Telegram. Throws on any failure for a managed sub (missing id, unknown user, API error) so `cancelSubscription`
   * turns it into an admin alert rather than a silent money leak.
   */
  override async cancel(subscription: Subscription): Promise<void> {
    if (!isNativeStarsSubscription(subscription, this.products)) {
      logger.info(
        `Subscription ${subscription.id} has no live Telegram Star subscription (one-time or already canceled there); cancel is a no-op`,
      );
      return;
    }

    const details = subscription.recurringDetails ?? {};
    // Prefer the stable first-charge id; the (possibly latest) legacy key is only for subs written before it existed.
    const chargeId = (details.telegram_subscription_charge_id || details.telegram_payment_charge_id) as
      | string
      | undefined;
    if (!chargeId) {
      // A legacy sub with no charge id stored. Telegram can't be told to stop, so throw instead of returning: otherwise
      // the DB reads CANCELED while Telegram keeps debiting and nobody is alerted.
      throw new Error(
        `Telegram Stars subscription ${subscription.id} has no stored charge id; cannot cancel auto-renewal at Telegram`,
      );
    }

    const user = await this.services.users.getUserById(subscription.userId);
    if (!user?.telegramId) {
      throw new Error(
        `Telegram Stars subscription ${subscription.id}: user/telegram_id unavailable; cannot cancel auto-renewal at Telegram`,
      );
    }

    await this.bot.api.editUserStarSubscription(user.telegramId, chargeId, true);
    // Remembered on the row: a later cancel or refund of it (e.g. after a card purchase merged in) doesn't ask Telegram
    // again.
    await this.repos.subscriptions.update(subscription.id, {
      recurringDetails: { ...details, telegram_subscription_canceled: true },
    });
    logger.info(`Canceled Telegram Stars subscription ${subscription.id} at Telegram (charge ${chargeId})`);
  }

  private async alertUnknownRefund(payment: Payment, refundedChargeId: string): Promise<void> {
    logger.error(
      `Telegram refunded charge ${refundedChargeId}, which matches no payment (the invoice's payment ${payment.id} is charge ${payment.providerMetadata?.telegram_payment_charge_id})`,
    );
    await this.services.messages.queueAdminBroadcast(
      `🚨 <b>Stars refund for an unknown charge</b>\n` +
        `Telegram refunded charge <code>${esc(refundedChargeId)}</code> of the subscription bought with ` +
        `payment <code>${payment.id}</code>, but no payment row has that charge. Nothing was marked ` +
        `refunded or taken back: check the user's access by hand.\n${tags('critical', 'refund')}`,
    );
  }
}
