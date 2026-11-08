import { createHash } from 'node:crypto';
import { settings } from '../../../config';
import { type Payment, PaymentEventType, PaymentStatus } from '../../../db/schema';
import { getLogger } from '../../../lib/logging';
import type { Repos } from '../../../repos';
import type { ProductCatalog } from '../products';
import {
  type CreatedPayment,
  type Json,
  type LivePaymentStatus,
  PaymentProviderInterface,
  PaymentValueError,
  type ProviderCallback,
  type RecurringDetails,
} from '../types';
import { type ExactTimestamp, errorMessage, isoformat } from '../utils';
import {
  parseWebhookNotification,
  type WebhookNotification,
  type YooKassaPayment,
  type YooKassaPaymentMethod,
  yookassaPayments,
  yookassaRefunds,
} from './yookassa-api';

const logger = getLogger('yookassa');

const YOOKASSA_LOCALES: Record<string, string> = { ru: 'ru_RU', en: 'en_US' };

const EMAIL = /^[^@]+@[^@]+\.[^@]+$/;
const DESCRIPTION_MAX_LENGTH = 128;

const NOTHING: ProviderCallback = { updateData: {}, eventType: null, payment: null, recurringDetails: null };

/**
 * How the payment was made or why it was canceled, for analytics: payment_method_type (bank_card, sbp, ...),
 * cancellation_reason (insufficient_funds, 3d_secure_failed, ...) and cancellation_party (payment_network, yoo_money,
 * merchant).
 */
function paymentDetails(remote: YooKassaPayment): Record<string, string> {
  const details = {
    payment_method_type: remote.payment_method?.type,
    cancellation_reason: remote.cancellation_details?.reason,
    cancellation_party: remote.cancellation_details?.party,
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value)) as Record<string, string>;
}

/** An app locale ('ru'/'en', maybe 'ru-RU') as a YooKassa widget locale, or `null` to auto-detect. */
function toYookassaLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  return YOOKASSA_LOCALES[locale.toLowerCase().split('-')[0] ?? ''] ?? null;
}

/** The SDK's `Amount`: the float's decimal digits, rounded half up to two places. */
const amountValue = (amount: number): string => (Math.round(Number(`${amount}e2`)) / 100).toFixed(2);

/**
 * Deterministic idempotency key for a renewal charge, stable for one billing period.
 *
 * A re-fired renewal for the same (subscription, period) reuses this key, so YooKassa dedups the create call. NOTE:
 * YooKassa's Idempotence-Key window only holds ~24h, so this is a best-effort backstop: the primary double-charge
 * guards are the SUCCEEDED-only dedup query, the `uq_payment_idempotency_key` index, and `wasRewarded` gating.
 *
 * The renewal job passes the end date as Postgres stored it (`ExactTimestamp`): a `Date` drops microseconds, so for an
 * `end_date` Python wrote the key would differ from the one Python computed, and a renewal row Python left behind for
 * the period would go unseen (a second charge). A `Date` is right only for a value with no sub-millisecond digits.
 */
export function renewalIdempotencyKey(subscriptionId: string, endDate: Date | ExactTimestamp): string {
  const period = endDate instanceof Date ? isoformat(endDate) : endDate.isoformat;
  const raw = `renewal:${subscriptionId}:${period}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

interface PaymentRequestOptions {
  descriptionPrefix?: string;
  /** A saved payment method: a recurring charge, no confirmation. */
  paymentMethodId?: string | null;
  locale?: string | null;
}

/** `POST /payments` body for a payment row. Throws `PaymentValueError` where the SDK's validation raises. */
export function buildPaymentRequest(
  products: ProductCatalog,
  payment: Pick<Payment, 'id' | 'productId' | 'userId' | 'currency'>,
  { descriptionPrefix = '', paymentMethodId = null, locale = null }: PaymentRequestOptions = {},
): Json {
  const product = products.getProduct(payment.productId);
  if (!product) throw new PaymentValueError(`Product ${payment.productId} not found`);

  const { receiptEmail } = settings.payment;
  if (!EMAIL.test(receiptEmail)) throw new PaymentValueError('Invalid email value type');

  const price = product.getPriceFor(payment.currency);
  if (Number(amountValue(price.amount)) <= 0) {
    throw new PaymentValueError(`Invalid payment amount value: ${amountValue(price.amount)}`);
  }

  const description = `${descriptionPrefix}${product.name} for user_id: ${payment.userId}`;
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new PaymentValueError(
      `The value of the description parameter is too long. Max length is ${DESCRIPTION_MAX_LENGTH}`,
    );
  }

  const request: Json = {
    amount: { value: amountValue(price.amount), currency: price.currency },
    capture: true,
    receipt: {
      customer: { email: receiptEmail },
      items: [
        {
          description: product.name,
          quantity: '1.0',
          amount: { value: amountValue(price.amount), currency: payment.currency },
          vat_code: 1,
        },
      ],
    },
    metadata: { app_payment_id: payment.id, is_recurring: product.recurring },
    description,
  };

  if (paymentMethodId) {
    request.payment_method_id = paymentMethodId;
  } else {
    const yookassaLocale = toYookassaLocale(locale);
    request.confirmation = { type: 'embedded', ...(yookassaLocale ? { locale: yookassaLocale } : {}) };
    if (product.recurring) request.save_payment_method = true;
  }
  return request;
}

export class YooKassaProvider extends PaymentProviderInterface {
  constructor(
    private readonly repos: Repos,
    private readonly products: ProductCatalog,
  ) {
    super();
  }

  async createPayment(payment: Payment, _returnUrl?: string | null, locale?: string | null): Promise<CreatedPayment> {
    const product = this.products.getProduct(payment.productId);
    if (!product) throw new PaymentValueError(`Product ${payment.productId} not found`);

    const request = buildPaymentRequest(this.products, payment, { locale });
    logger.info(`Creating payment for product ${product.productId} for user ${payment.userId}`);
    const response = await yookassaPayments.create(request, payment.idempotencyKey);
    logger.info(`Provider payment created with id: ${response.id}`);
    if (!response.confirmation) throw new Error(`Provider payment ${response.id} came without a confirmation`);

    const price = product.getPriceFor(payment.currency);
    return {
      paymentUpdates: {
        status: PaymentStatus.WAITING_FOR_ACTION,
        providerPaymentId: response.id,
        providerMetadata: response.metadata ?? {},
      },
      returnData: {
        payment_id: payment.id,
        confirmation_token: response.confirmation.confirmation_token,
        amount: price.amount,
        currency: price.currency,
      },
    };
  }

  async processCallback(payload: Json): Promise<ProviderCallback> {
    let notification: WebhookNotification;
    try {
      notification = parseWebhookNotification(payload);
    } catch (e) {
      logger.error(`Error processing webhook: ${errorMessage(e)}`);
      return NOTHING;
    }

    // A refund.* body carries a refund object (id, payment_id, amount), not a payment.
    if (notification.event.startsWith('refund.')) return this.processRefundCallback(notification);

    // SECURITY: never trust the webhook body. YooKassa does not sign notifications, so a forged "payment.succeeded"
    // body must not be able to grant a subscription. Re-fetch the authoritative payment object and drive every
    // decision off its real status, not the body.
    let remote: YooKassaPayment;
    try {
      remote = await yookassaPayments.findOne(notification.object.id);
    } catch (e) {
      // Transient YooKassa failure during webhook delivery: do NOT act on the (untrusted) body. The payment stays
      // non-final; a later webhook or reconciliation resolves it.
      logger.error(`Failed to re-fetch payment ${notification.object.id} from YooKassa: ${errorMessage(e)}`);
      return NOTHING;
    }

    if (!remote) {
      logger.error(`Re-fetch returned no payment for ${notification.object.id}`);
      return NOTHING;
    }

    const appPaymentId = remote.metadata?.app_payment_id;
    if (!appPaymentId) {
      logger.error('Missing app_payment_id in re-fetched payment metadata');
      return NOTHING;
    }

    const payment = await this.repos.payments.getById(appPaymentId);
    if (!payment) {
      logger.error(`Payment not found for app_payment_id: ${appPaymentId}`);
      return NOTHING;
    }

    let recurringDetails: RecurringDetails = {};
    let newStatus: PaymentStatus;
    let eventType: PaymentEventType;
    if (remote.status === 'succeeded') {
      newStatus = PaymentStatus.SUCCEEDED;
      eventType = PaymentEventType.PAYMENT_SUCCEEDED;
      // Prefer the re-fetched payment_method; fall back to the notification body so a first-time saved card still
      // yields a recurring token. Warn only if both are empty on a recurring product (its renewals would otherwise
      // silently fail).
      const method = remote.payment_method ?? (notification.object.payment_method as YooKassaPaymentMethod | undefined);
      if (method?.id) {
        recurringDetails.payment_method_id = method.id;
      } else if (this.products.getProduct(payment.productId)?.recurring) {
        logger.warn(`Succeeded payment ${remote.id} has no payment_method id; recurring renewal will fail`);
      }
      recurringDetails = { ...recurringDetails, ...paymentDetails(remote) };
    } else if (remote.status === 'canceled') {
      newStatus = PaymentStatus.CANCELED;
      eventType = PaymentEventType.PAYMENT_CANCELED;
      recurringDetails = paymentDetails(remote); // why it was canceled, for analytics
    } else if (remote.status === 'waiting_for_capture') {
      newStatus = PaymentStatus.WAITING_FOR_ACTION;
      eventType = PaymentEventType.PROVIDER_RESPONSE;
    } else {
      // pending / unknown: leave the payment as it is; a later event resolves it.
      newStatus = payment.status;
      eventType = PaymentEventType.PROVIDER_RESPONSE;
    }

    logger.info(`Processed callback for payment ${payment.id}: authoritative remote status ${remote.status}`);
    return {
      // No isRecurring here: it's set when the row is created (a renewal by the renewal job, a purchase by the user).
      // The metadata "is_recurring" is "save the card for renewals", true on first purchases too.
      updateData: {
        status: newStatus,
        providerMetadata: { webhook: payload, remote_status: remote.status, provider_payment_id: remote.id },
      },
      eventType,
      payment,
      recurringDetails,
    };
  }

  /**
   * A refund of one of our payments. Refunds are made by hand in the YooKassa dashboard.
   *
   * Same rule as payments: the body isn't signed, so the refund is re-fetched and only the authoritative object is
   * acted on. A succeeded refund of the full amount marks the payment REFUNDED (out of revenue); a partial one is
   * recorded but keeps it SUCCEEDED. Subscriptions are not touched: whoever refunded decides about access.
   */
  private async processRefundCallback(notification: WebhookNotification): Promise<ProviderCallback> {
    let refund: Awaited<ReturnType<typeof yookassaRefunds.findOne>>;
    try {
      refund = await yookassaRefunds.findOne(notification.object.id);
    } catch (e) {
      logger.error(`Failed to re-fetch refund ${notification.object.id} from YooKassa: ${errorMessage(e)}`);
      return NOTHING;
    }
    if (!refund) {
      logger.error(`Re-fetch returned no refund for ${notification.object.id}`);
      return NOTHING;
    }

    const payment = await this.repos.payments.getByProviderPaymentId(refund.payment_id);
    if (!payment) {
      logger.error(`Refund ${refund.id} is for unknown payment ${refund.payment_id}`);
      return NOTHING;
    }

    const refunded = Number(refund.amount.value);
    const providerMetadata = {
      ...payment.providerMetadata,
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refunded,
        currency: refund.amount.currency,
        description: refund.description ?? null,
      },
    };
    const providerResponse: ProviderCallback = {
      updateData: { providerMetadata },
      eventType: PaymentEventType.PROVIDER_RESPONSE,
      payment,
      recurringDetails: {},
    };
    if (refund.status !== 'succeeded') return providerResponse;
    if (refunded < payment.amount) {
      logger.warn(`Partial refund ${refund.id} of payment ${payment.id}: ${refunded} of ${payment.amount}`);
      return providerResponse;
    }
    return {
      updateData: { status: PaymentStatus.REFUNDED, providerMetadata },
      eventType: PaymentEventType.PAYMENT_REFUNDED,
      payment,
      recurringDetails: {},
    };
  }

  /**
   * Reconcile live status with `findOne`, falling back to the stored one. On a SUCCEEDED reconcile, also surface the
   * saved payment method, the same way `processCallback` does, so the reconcile path can grant entitlement, including
   * a future-renewable subscription, exactly like the webhook.
   */
  override async getPaymentStatus(payment: Payment): Promise<LivePaymentStatus> {
    const stored: LivePaymentStatus = { status: payment.status, recurringDetails: {} };
    if (!payment.providerPaymentId) return stored;

    let remote: YooKassaPayment;
    try {
      remote = await yookassaPayments.findOne(payment.providerPaymentId);
    } catch (e) {
      logger.error(`Error fetching payment status from YooKassa for ${payment.id}: ${errorMessage(e)}`);
      return stored;
    }
    if (!remote) return stored;

    const statusMap: Record<string, PaymentStatus> = {
      succeeded: PaymentStatus.SUCCEEDED,
      canceled: PaymentStatus.CANCELED,
      waiting_for_capture: PaymentStatus.WAITING_FOR_ACTION,
      pending: PaymentStatus.WAITING_FOR_ACTION,
    };
    const mapped = Object.hasOwn(statusMap, remote.status) ? statusMap[remote.status] : undefined;
    if (mapped === undefined) {
      logger.warn(`Unknown YooKassa status '${remote.status}' for payment ${payment.id}`);
      return stored;
    }
    if (mapped === PaymentStatus.CANCELED) return { status: mapped, recurringDetails: paymentDetails(remote) };
    if (mapped !== PaymentStatus.SUCCEEDED) return { status: mapped, recurringDetails: {} };

    const recurringDetails: RecurringDetails = paymentDetails(remote);
    if (remote.payment_method?.id) {
      recurringDetails.payment_method_id = remote.payment_method.id;
    } else if (this.products.getProduct(payment.productId)?.recurring) {
      logger.warn(`Succeeded payment ${remote.id} (reconcile) has no payment_method id; recurring renewal will fail`);
    }
    return { status: mapped, recurringDetails };
  }

  async chargeRecurring(payment: Payment, recurringDetails: RecurringDetails): Promise<ProviderCallback> {
    const paymentMethodId = recurringDetails.payment_method_id;
    if (!paymentMethodId) {
      logger.error(`No payment method id for payment ${payment.id}`);
      return NOTHING;
    }

    logger.info(`Initiating recurring charge for payment ${payment.id}`);
    const request = buildPaymentRequest(this.products, payment, {
      descriptionPrefix: 'Auto-renewal: ',
      paymentMethodId: String(paymentMethodId),
    });
    const response = await yookassaPayments.create(request, recurringDetails.idempotency_key as string | undefined);
    logger.info(
      `Recurring charge response for payment ${payment.id}: status ${response.status}, provider id ${response.id}`,
    );

    const succeeded = response.status === 'succeeded';
    return {
      updateData: {
        status: succeeded ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
        providerPaymentId: response.id,
        providerMetadata: response.metadata ?? {},
        isRecurring: true,
      },
      eventType: succeeded ? PaymentEventType.PAYMENT_SUCCEEDED : PaymentEventType.PAYMENT_FAILED,
      payment,
      recurringDetails: {},
    };
  }
}
