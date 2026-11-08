import { z } from 'zod';
import type { PaymentStatus } from '../../db/schema';
import type { PaymentReturnData } from './types';

export const StartPurchaseRequest = z.object({
  product_id: z.string(),
  currency: z.string().default('RUB'),
  provider_id: z.string().default('YOOKASSA'),
  return_url: z.string().nullable().default(null),
  locale: z.string().nullable().default(null),
});
export type StartPurchaseRequest = z.infer<typeof StartPurchaseRequest>;

export interface ProductPriceSchema {
  currency: string;
  amount: number;
}

/** A product as `PaymentsService` lists it. */
export interface ProductListing {
  id: string;
  name: string;
  price: number;
  currency: string;
  durationDays: number;
  recurring: boolean;
  /** Every currency it can be bought in (RUB/USD for card, XTR for Telegram Stars). */
  prices: ProductPriceSchema[];
}

export const toProductResponse = (product: ProductListing) => ({
  id: product.id,
  name: product.name,
  price: product.price,
  currency: product.currency,
  duration_days: product.durationDays,
  is_recurring: product.recurring,
  prices: product.prices,
});

/** Only the response's fields: `returnData` carries more (`status`, `provider`, `error`). */
export const toStartPurchaseResponse = (data: PaymentReturnData) => ({
  payment_id: data.payment_id,
  confirmation_token: data.confirmation_token ?? null,
  confirmation_url: data.confirmation_url ?? null,
  amount: data.amount,
  currency: data.currency,
});

export const toPaymentStatusResponse = (payment: { id: string; status: PaymentStatus }) => ({
  payment_id: payment.id,
  status: payment.status,
});
