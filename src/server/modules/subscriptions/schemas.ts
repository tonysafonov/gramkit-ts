import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type PaymentProvider, type Subscription, SubscriptionStatus } from '../../db/schema';

export const CancelSubscriptionRequest = z.object({
  reason: z.string().max(50).nullable().default(null),
  feedback: z.string().nullable().default(null),
});
export type CancelSubscriptionRequest = z.infer<typeof CancelSubscriptionRequest>;

export interface SubscriptionSchema {
  id: string;
  userId: string;
  productId: string;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  canceledAt: Date | null;
  cancellationReason: string | null;
  cancellationFeedback: string | null;
  /** Whether the subscription gives premium access. */
  hasAccess: boolean;
}

export interface SubscriptionWithDetailsSchema extends SubscriptionSchema {
  providerId: PaymentProvider;
  productPrice: number;
  currency: string;
}

const hasAccess = (endDate: Date): boolean => Date.now() < endDate.getTime();

export const toSubscriptionSchema = (row: Subscription): SubscriptionSchema => ({
  id: row.id,
  userId: row.userId,
  productId: row.productId,
  status: row.status,
  startDate: row.startDate,
  endDate: row.endDate,
  canceledAt: row.canceledAt,
  cancellationReason: row.cancellationReason,
  cancellationFeedback: row.cancellationFeedback,
  hasAccess: hasAccess(row.endDate),
});

/** The answer for a user with no subscription: status NONE, ended a day ago. */
export function getMockSubscription(userId: string): SubscriptionSchema {
  const mockTime = new Date(Date.now() - 86_400_000);
  return {
    id: randomUUID(),
    userId,
    productId: 'MOCK',
    status: SubscriptionStatus.NONE,
    startDate: mockTime,
    endDate: mockTime,
    canceledAt: mockTime,
    cancellationReason: null,
    cancellationFeedback: null,
    hasAccess: hasAccess(mockTime),
  };
}

export const toSubscriptionResponse = (subscription: SubscriptionSchema) => ({
  id: subscription.id,
  user_id: subscription.userId,
  product_id: subscription.productId,
  status: subscription.status,
  start_date: subscription.startDate.toISOString(),
  end_date: subscription.endDate.toISOString(),
  canceled_at: subscription.canceledAt?.toISOString() ?? null,
  cancellation_reason: subscription.cancellationReason,
  cancellation_feedback: subscription.cancellationFeedback,
  has_access: subscription.hasAccess,
});

export const toSubscriptionWithDetailsResponse = (subscription: SubscriptionWithDetailsSchema) => ({
  ...toSubscriptionResponse(subscription),
  provider_id: subscription.providerId,
  product_price: subscription.productPrice,
  currency: subscription.currency,
});
