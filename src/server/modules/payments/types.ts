/** Port of `core/services/payments/types.py`: the provider contract and the errors around it. */
import type { NewPayment, Payment, PaymentEventType, PaymentStatus, Subscription } from '../../db/schema';

export type Json = Record<string, unknown>;

/** What a provider hands down to `topUpSubscription`, stored on the subscription row. Keys are snake_case JSON. */
export type RecurringDetails = Record<string, unknown>;

export type PaymentUpdate = Partial<NewPayment>;

/** The user has already bought the product's daily limit (`dailyPurchaseLimit`) in 24 h. */
export class PurchaseLimitError extends Error {
  override readonly name = 'PurchaseLimitError';
}

/** The payment provider refused or failed the refund call (nothing was refunded). */
export class ProviderRefundError extends Error {
  override readonly name = 'ProviderRefundError';
}

/** Python's `ValueError` on this path: what was asked can't be done. A route turns it into a 400. */
export class PaymentValueError extends Error {
  override readonly name = 'PaymentValueError';
}

/** The wire data of a started payment, stored as is in `payment_events.raw_data`. */
export interface PaymentReturnData {
  payment_id: string;
  confirmation_token?: string | null;
  confirmation_url?: string | null;
  amount: number;
  currency: string;
  status?: string;
  provider?: string;
  error?: string;
}

export interface CreatedPayment {
  paymentUpdates: PaymentUpdate;
  returnData: PaymentReturnData;
}

/** What a provider made of a callback. `eventType` or `payment` null: nothing to act on. */
export interface ProviderCallback {
  updateData: PaymentUpdate;
  eventType: PaymentEventType | null;
  payment: Payment | null;
  recurringDetails: RecurringDetails | null;
}

export interface LivePaymentStatus {
  status: PaymentStatus;
  recurringDetails: RecurringDetails;
}

export abstract class PaymentProviderInterface {
  /** Whether `refund` is implemented (`PaymentsService.refundPayment` checks before writing anything). */
  readonly supportsRefund: boolean = false;

  abstract createPayment(payment: Payment, returnUrl?: string | null, locale?: string | null): Promise<CreatedPayment>;

  abstract processCallback(payload: Json): Promise<ProviderCallback>;

  abstract chargeRecurring(payment: Payment, recurringDetails: RecurringDetails): Promise<ProviderCallback>;

  /**
   * Default: the stored status, no recurring details (no live reconcile). YooKassa overrides this to reconcile live
   * and surface the details, so the reconcile path can grant entitlement just like the webhook.
   */
  async getPaymentStatus(payment: Payment): Promise<LivePaymentStatus> {
    return { status: payment.status, recurringDetails: {} };
  }

  /**
   * Stop future provider-driven renewals. Default: no-op. YooKassa renewals are driven by our own dunning job (which
   * only selects ACTIVE/PAST_DUE subs), so CANCELED in our DB already stops them. Telegram Stars overrides this:
   * Telegram auto-debits on its own schedule, so it must be told or it keeps charging a "canceled" user.
   */
  async cancel(_subscription: Subscription): Promise<void> {}

  /**
   * Return a succeeded payment's money to the user. Throws on failure. Default: not supported: YooKassa refunds are
   * made by hand in its dashboard and arrive as refund.* webhooks. Telegram Stars overrides this.
   */
  async refund(payment: Payment): Promise<void> {
    throw new Error(`Refunds are not supported for provider ${payment.providerId}`);
  }
}
