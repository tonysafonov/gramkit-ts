/** Enums are stored as plain varchars (SQLAlchemy `native_enum=False`), so these are value maps, not pg enums. */

type Values<T> = T[keyof T];

export const enumValues = <T extends Record<string, string>>(e: T) => Object.values(e) as [Values<T>, ...Values<T>[]];

export const AuthMethod = { TELEGRAM: 'telegram', EMAIL: 'email' } as const;
export type AuthMethod = Values<typeof AuthMethod>;

export const PaymentProvider = {
  YOOKASSA: 'YOOKASSA',
  TELEGRAM_STARS: 'TELEGRAM_STARS',
  GIFT: 'GIFT',
} as const;
export type PaymentProvider = Values<typeof PaymentProvider>;

export const PaymentStatus = {
  CREATED: 'CREATED',
  WAITING_FOR_ACTION: 'WAITING_FOR_ACTION',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  /** Fully refunded after SUCCEEDED: the only transition out of a final state. */
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = Values<typeof PaymentStatus>;

const FINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
  PaymentStatus.CANCELED,
  PaymentStatus.REFUNDED,
]);

/** A final payment state must not be overwritten. */
export const isFinalPaymentStatus = (status: PaymentStatus): boolean => FINAL_PAYMENT_STATUSES.has(status);

export const PaymentEventType = {
  PAYMENT_CREATED: 'PAYMENT_CREATED',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PROVIDER_RESPONSE: 'PROVIDER_RESPONSE',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_CANCELED: 'PAYMENT_CANCELED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
} as const;
export type PaymentEventType = Values<typeof PaymentEventType>;

export const SubscriptionStatus = {
  NONE: 'NONE',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  /** Renewal failing, in grace: still entitled, retried daily by dunning. */
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
} as const;
export type SubscriptionStatus = Values<typeof SubscriptionStatus>;

export const NotificationTimeSlot = { MORNING: 'MORNING', EVENING: 'EVENING' } as const;
export type NotificationTimeSlot = Values<typeof NotificationTimeSlot>;

/** When a logged notification went out (`notification_deliveries.slot`). */
export const NotificationSlot = { MORNING: 'morning', EVENING: 'evening', OTHER: 'other' } as const;
export type NotificationSlot = Values<typeof NotificationSlot>;

export const UserType = { GUEST: 'GUEST', REGISTERED: 'REGISTERED' } as const;
export type UserType = Values<typeof UserType>;

export const UserRole = { USER: 'user', ADMIN: 'admin', OWNER: 'owner' } as const;
export type UserRole = Values<typeof UserRole>;

export const SpreadType = {
  DAILY: 'DAILY',
  SINGLE_CARD: 'SINGLE_CARD',
  THREE_CARD: 'THREE_CARD',
  YES_NO: 'YES_NO',
  LOVE: 'LOVE',
  A_OR_B: 'A_OR_B',
  FINANCIAL: 'FINANCIAL',
  DESTINY: 'DESTINY',
  EDUCATION: 'EDUCATION',
  EX_PARTNER: 'EX_PARTNER',
  DISAPPEARANCE: 'DISAPPEARANCE',
  WAIT_OR_RELEASE: 'WAIT_OR_RELEASE',
  SITUATION: 'SITUATION',
  CAREER_CROSSROADS: 'CAREER_CROSSROADS',
  TALENT: 'TALENT',
  SELF_DISCOVERY: 'SELF_DISCOVERY',
  OB_DAILY: 'OB_DAILY',
  OB_THREE_CARD: 'OB_THREE_CARD',
} as const;
export type SpreadType = Values<typeof SpreadType>;
